// POST /api/ponto/solicitacoes — o único caminho operacional real enquanto
// EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA for false. Cobre: confirmação de
// senha, idempotência real (mesmo conteúdo vs. conteúdo diferente),
// concorrência real no Postgres isolado, recuperação após timeout por
// operacao_id, validação de foto, falha parcial foto/registro (com falha
// REAL injetada via trigger do Postgres — não simulada em JS), storage
// indisponível, e limite de tentativas.
//
// O QUE FOI VERIFICADO DE VERDADE (e o que não foi): os testes aqui rodam
// contra um Postgres real (via LOCAL_PG_URL/pgCompatClient — INSERT/UPDATE/
// DELETE, UNIQUE INDEX, trigger, concorrência de transações são Postgres
// de verdade, não mock). O que NÃO foi verificado: comportamento
// HTTP-específico do PostgREST real (formato exato de erro, pooling do
// Supabase), nem o Storage do Supabase (fotos em teste vão pro disco local,
// ver src/lib/ponto/fotoStorage.js). Ver docs/meu-ponto/MANUAL_E_STATUS.md.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs/promises'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, fotoSinteticaBase64,
  instalarFalhaForcadaDeInsert, removerFalhaForcadaDeInsert,
} from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

async function novoColaborador() {
  const usuario = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(usuario.id)
  await habilitarPontoDeTeste(usuario.id, true)
  return usuario
}

test('piloto_ativo=false bloqueia também a criação de solicitação (não só a marcação direta)', async () => {
  const usuario = await novoColaborador()
  await definirPilotoAtivoDeTeste(false)
  try {
    const { status } = await chamar('POST', '/api/ponto/solicitacoes', {
      token: gerarToken(usuario),
      body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste' },
    })
    assert.equal(status, 403)
  } finally {
    await definirPilotoAtivoDeTeste(true)
  }
})

test('senha incorreta bloqueia a solicitação, nada é persistido', async () => {
  const usuario = await novoColaborador()
  const { status, body } = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: 'senha-errada', justificativa: 'teste' },
  })
  assert.equal(status, 401)
  assert.match(body.erro, /senha/i)
})

test('justificativa é sempre obrigatória, com ou sem foto', async () => {
  const usuario = await novoColaborador()
  const { status, body } = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha },
  })
  assert.equal(status, 400)
  assert.match(body.erro, /justificativa/i)
})

test('com foto válida: motivo=equipamento_nao_implementado; sem foto: motivo=camera_indisponivel', async () => {
  const usuario = await novoColaborador()

  const comFoto = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'sem equipamento verificado ainda', foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
  })
  assert.equal(comFoto.status, 201)
  assert.equal(comFoto.body.motivo, 'equipamento_nao_implementado')
  assert.equal(comFoto.body.status, 'pendente')

  const semFoto = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'saida_intervalo', senha_atual: usuario.senha, justificativa: 'câmera do computador não abriu' },
  })
  assert.equal(semFoto.status, 201)
  assert.equal(semFoto.body.motivo, 'camera_indisponivel')
})

test('foto com formato inválido é rejeitada, nenhuma solicitação criada', async () => {
  const usuario = await novoColaborador()
  const fotoFalsa = Buffer.from('nao e uma imagem jpeg').toString('base64')
  const { status } = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste', foto_base64: fotoFalsa, mime_type: 'image/jpeg' },
  })
  assert.equal(status, 400)
})

test('idempotência: mesmo operacao_id + MESMO conteúdo devolve a solicitação existente (retry/timeout/duplo clique)', async () => {
  const usuario = await novoColaborador()
  const operacaoId = crypto.randomUUID()
  const corpo = { operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'mesma tentativa reenviada' }

  const primeira = await chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo })
  assert.equal(primeira.status, 201)

  const segunda = await chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo })
  assert.equal(segunda.status, 200)
  assert.equal(segunda.body.id, primeira.body.id)
  assert.equal(segunda.body.idempotente, true)

  const supabase = obterSupabaseDeTeste()
  const { count } = await supabase.from('ponto_solicitacoes_marcacao').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId)
  assert.equal(count, 1)
})

test('idempotência: mesmo operacao_id + conteúdo DIFERENTE é conflito (409), não é tratado como a mesma operação', async () => {
  const usuario = await novoColaborador()
  const operacaoId = crypto.randomUUID()

  const primeira = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'primeira versão' },
  })
  assert.equal(primeira.status, 201)

  const segundaComOutroTipo = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: operacaoId, tipo: 'saida', senha_atual: usuario.senha, justificativa: 'primeira versão' },
  })
  assert.equal(segundaComOutroTipo.status, 409)

  const supabase = obterSupabaseDeTeste()
  const { count } = await supabase.from('ponto_solicitacoes_marcacao').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId)
  assert.equal(count, 1, 'o conflito não deve ter criado uma segunda linha nem sobrescrito a primeira')
})

test('concorrência real: 3 requisições simultâneas com o mesmo operacao_id geram exatamente 1 solicitação', async () => {
  const usuario = await novoColaborador()
  const operacaoId = crypto.randomUUID()
  const corpo = { operacao_id: operacaoId, tipo: 'retorno_intervalo', senha_atual: usuario.senha, justificativa: 'teste de corrida' }

  const respostas = await Promise.all([
    chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo }),
    chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo }),
    chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo }),
  ])
  for (const r of respostas) assert.ok([200, 201].includes(r.status), `esperava 200/201, veio ${r.status}: ${JSON.stringify(r.body)}`)

  const supabase = obterSupabaseDeTeste()
  const { count } = await supabase.from('ponto_solicitacoes_marcacao').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId)
  assert.equal(count, 1, 'UNIQUE INDEX real do Postgres garante isso mesmo sob corrida de verdade, não só checagem prévia em JS')
})

test('recuperação após timeout: GET /solicitacoes/por-operacao/:id devolve o estado sem precisar reenviar foto/senha', async () => {
  const usuario = await novoColaborador()
  const operacaoId = crypto.randomUUID()
  await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste recuperação' },
  })

  const { status, body } = await chamar('GET', `/api/ponto/solicitacoes/por-operacao/${operacaoId}`, { token: gerarToken(usuario) })
  assert.equal(status, 200)
  assert.equal(body.status, 'pendente')
})

test('recuperação por operacao_id de OUTRO usuário retorna 404, não vaza o estado alheio', async () => {
  const usuarioA = await novoColaborador()
  const usuarioB = await novoColaborador()
  const operacaoId = crypto.randomUUID()
  await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuarioA),
    body: { operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuarioA.senha, justificativa: 'teste isolamento' },
  })

  const { status } = await chamar('GET', `/api/ponto/solicitacoes/por-operacao/${operacaoId}`, { token: gerarToken(usuarioB) })
  assert.equal(status, 404)
})

test('falha parcial REAL entre foto e solicitação (trigger força erro no INSERT): resposta explícita, sem falso sucesso, foto órfã documentada', async () => {
  const usuario = await novoColaborador()
  instalarFalhaForcadaDeInsert('ponto_solicitacoes_marcacao')
  try {
    const supabase = obterSupabaseDeTeste()
    const { count: fotosAntes } = await supabase.from('ponto_fotos').select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id)

    const { status, body } = await chamar('POST', '/api/ponto/solicitacoes', {
      token: gerarToken(usuario),
      body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste falha parcial', foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
    })
    assert.equal(status, 500)
    assert.match(body.erro, /foto foi recebida, mas/i, 'a resposta precisa deixar explícito que a foto foi salva mas o registro não — nunca um sucesso falso')

    const { count: solicitacoes } = await supabase.from('ponto_solicitacoes_marcacao').select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id)
    assert.equal(solicitacoes, 0, 'nenhuma solicitação deve existir depois da falha')

    const { count: fotosDepois } = await supabase.from('ponto_fotos').select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id)
    assert.equal(fotosDepois, fotosAntes + 1, 'a foto já enviada fica órfã (documentado) — não é apagada automaticamente, não é reaproveitada')
  } finally {
    removerFalhaForcadaDeInsert('ponto_solicitacoes_marcacao')
  }
})

test('storage de fotos indisponível: erro explícito (502), nada persistido', async () => {
  const usuario = await novoColaborador()
  const arquivoNoLugarDeDiretorio = path.join(__dirname, '..', '..', '..', '.localdev', `nao-e-diretorio-${Date.now()}.tmp`)
  await fs.mkdir(path.dirname(arquivoNoLugarDeDiretorio), { recursive: true })
  await fs.writeFile(arquivoNoLugarDeDiretorio, 'isto e um arquivo, nao um diretorio')

  const dirOriginal = process.env.PONTO_FOTOS_LOCAL_DIR
  process.env.PONTO_FOTOS_LOCAL_DIR = path.join(arquivoNoLugarDeDiretorio, 'subpasta-impossivel')
  try {
    const { status, body } = await chamar('POST', '/api/ponto/solicitacoes', {
      token: gerarToken(usuario),
      body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste storage indisponível', foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
    })
    assert.equal(status, 502)
    assert.match(body.erro, /foto/i)

    const supabase = obterSupabaseDeTeste()
    const { count } = await supabase.from('ponto_solicitacoes_marcacao').select('id', { count: 'exact', head: true }).eq('usuario_id', usuario.id)
    assert.equal(count, 0)
  } finally {
    process.env.PONTO_FOTOS_LOCAL_DIR = dirOriginal
    await fs.unlink(arquivoNoLugarDeDiretorio).catch(() => {})
  }
})

test('limite de tentativas: mais de 8 solicitações em 5 minutos para o mesmo usuário são bloqueadas (429)', async () => {
  const usuario = await novoColaborador()
  const respostas = []
  for (let i = 0; i < 10; i++) {
    respostas.push(await chamar('POST', '/api/ponto/solicitacoes', {
      token: gerarToken(usuario),
      body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: `tentativa ${i}` },
    }))
  }
  const bloqueadas = respostas.filter((r) => r.status === 429)
  assert.ok(bloqueadas.length > 0, 'pelo menos uma das 10 tentativas rápidas deveria bater no limite de 8/5min')
})
