// Auditoria adversarial independente do componente de equipamento —
// EXERCITA A ROTA HTTP REAL (src/routes/ponto.js), não a camada de serviço.
//
// Todos os testes de componente-equipamento.test.mjs chamam
// equipamentoService.{emitirDesafio,registrarMarcacaoAssinada} DIRETAMENTE,
// contornando deliberadamente a rota Express (ver comentário no topo
// daquele arquivo). Isso prova que o MECANISMO funciona, mas nunca exercitou
// o código real de src/routes/ponto.js que fica ACIMA da chamada ao serviço
// (checagem de idempotência, senha, foto, extração de campos do corpo) —
// esse código só é alcançável via HTTP, e a rota real sempre retorna 501
// enquanto EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA for false (ver
// componente-equipamento-gate-http.test.mjs).
//
// Este arquivo usa `node:test`'s `mock.module` (requer
// --experimental-test-module-mocks, adicionado só para a suíte de testes em
// scripts/run-ponto-tests.mjs) para sobrescrever, SÓ DENTRO DESTE PROCESSO
// de teste isolado (cada arquivo de scripts/tests/ponto roda como processo
// `node` separado — ver scripts/run-ponto-tests.mjs), o valor de
// EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA para `true`. O arquivo real
// src/lib/ponto/equipamento.js NUNCA é modificado em disco — a constante
// exportada por ele continua `false` em todo lugar fora deste processo de
// teste (produção, outros arquivos de teste, `git diff`). Isto permite
// provar que o código real ABAIXO do gate (nunca antes exercitado via HTTP)
// se comporta corretamente, sem correr o risco de esquecer a constante
// ligada em produção.
//
// Cada teste cria seu(s) próprio(s) colaborador(es) — não reaproveita um
// usuário global entre testes — porque /desafios e /marcacoes compartilham
// o MESMO rate limiter (limiteTentativasSensiveis, 8 tentativas/5min por
// usuário, ver src/routes/ponto.js); reaproveitar um usuário faria os
// últimos testes do arquivo falharem com 429, não com o status esperado.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const equipamentoModUrl = pathToFileURL(path.join(__dirname, '..', '..', '..', 'src', 'lib', 'ponto', 'equipamento.js')).href

mock.module(equipamentoModUrl, {
  namedExports: {
    EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA: true,
    MENSAGEM_EQUIPAMENTO_NAO_IMPLEMENTADO: 'não deveria aparecer neste arquivo — o gate está mockado como aberto',
  },
})

// Import dinâmico DEPOIS do mock.module acima — _setup.mjs importa
// dinamicamente src/routes/ponto.js (que importa equipamento.js) só quando
// subirServidorDeTeste() é chamado, então a ordem aqui garante que o mock já
// está registrado antes de qualquer coisa tocar o módulo real.
const {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste, chamar, gerarToken,
  criarUsuarioDeTeste, habilitarPontoDeTeste, definirPilotoAtivoDeTeste,
  criarEquipamentoDeTeste, vincularEquipamentoDeTesteComChaveNode, revogarEquipamentoDeTeste,
  limparVinculosCircularesDeTeste, fotoSinteticaBase64,
} = await import('./_setup.mjs')

let admin
let supabase
const usuarioIdsCriados = []

before(async () => {
  await subirServidorDeTeste()
  supabase = obterSupabaseDeTeste()
  await definirPilotoAtivoDeTeste(true)
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  usuarioIdsCriados.push(admin.id)
})

after(async () => {
  await limparVinculosCircularesDeTeste(usuarioIdsCriados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', usuarioIdsCriados)
  await supabase.from('ponto_desafios').delete().in('usuario_id', usuarioIdsCriados)
  await supabase.from('ponto_equipamento_eventos').delete().in('usuario_id', usuarioIdsCriados)
  await supabase.from('ponto_equipamentos').delete().in('usuario_id', usuarioIdsCriados)
  await pararServidorDeTeste()
})

async function criarColaboradorHabilitado() {
  const usuario = await criarUsuarioDeTeste()
  usuarioIdsCriados.push(usuario.id)
  await habilitarPontoDeTeste(usuario.id, true)
  const token = gerarToken(usuario)
  return { usuario, token }
}

function assinar(privateKey, payloadBuffer) {
  return crypto.sign('sha256', payloadBuffer, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64')
}

async function montarEquipamentoAssinante(usuario) {
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: usuario.id, cadastradoPor: admin.id })
  const { privateKey } = await vincularEquipamentoDeTesteComChaveNode({ equipamentoId })
  return { equipamentoId, privateKey }
}

// Faz o fluxo real via HTTP: pede desafio real (POST /desafios), assina com
// a chave privada de teste, chama POST /marcacoes real. Devolve a resposta
// HTTP crua para o chamador decidir o que verificar.
async function marcarViaHttp({ token, usuario, equipamentoId, privateKey, tipo, operacaoId }) {
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')
  // fotoSinteticaBase64 produz bytes JPEG reais o suficiente pra passar em
  // validarFotoBuffer (magic bytes) — o mesmo padrão usado no resto da
  // suíte (_setup.mjs), nunca uma foto de pessoa real.
  const fotoBase64 = fotoSinteticaBase64({ tamanhoBytes: 200 + Math.floor(Math.random() * 50) })
  const hash = calcularHashConteudo(Buffer.from(fotoBase64, 'base64'))

  const resDesafio = await chamar('POST', '/api/ponto/desafios', {
    token,
    body: { equipamento_id: equipamentoId, tipo, hash_conteudo: hash },
  })
  assert.equal(resDesafio.status, 201, `esperava desafio real emitido com sucesso, recebi ${resDesafio.status}: ${JSON.stringify(resDesafio.body)}`)

  const payload = payloadAssinaturaEquipamento({
    nonce: resDesafio.body.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo, hashConteudo: hash,
  })
  const assinatura = assinar(privateKey, payload)

  const resMarcacao = await chamar('POST', '/api/ponto/marcacoes', {
    token,
    body: {
      operacao_id: operacaoId, tipo, senha_atual: usuario.senha,
      foto_base64: fotoBase64, mime_type: 'image/jpeg',
      equipamento_id: equipamentoId, nonce: resDesafio.body.nonce, assinatura,
    },
  })
  return { resDesafio, resMarcacao, fotoBase64, hash }
}

test('caminho feliz via HTTP real: desafio + assinatura + marcação, ponta a ponta, através da rota Express de verdade', async () => {
  const { usuario, token } = await criarColaboradorHabilitado()
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante(usuario)
  const operacaoId = crypto.randomUUID()

  const { resMarcacao } = await marcarViaHttp({ token, usuario, equipamentoId, privateKey, tipo: 'entrada', operacaoId })

  assert.equal(resMarcacao.status, 201)
  assert.equal(resMarcacao.body.origem, 'normal')
  assert.equal(resMarcacao.body.idempotente, false)

  const { data: marcacao } = await supabase.from('ponto_marcacoes').select('usuario_id, equipamento_id').eq('id', resMarcacao.body.id).single()
  assert.equal(marcacao.usuario_id, usuario.id)
  assert.equal(marcacao.equipamento_id, equipamentoId)
})

// ACHADO CENTRAL desta auditoria: a checagem de idempotência em
// POST /api/ponto/marcacoes (src/routes/ponto.js) consultava
// `ponto_marcacoes` só por `operacao_id`, SEM filtrar por `usuario_id` — e
// esse retorno antecipado acontece ANTES da verificação de senha e ANTES de
// qualquer verificação de assinatura de equipamento. Resultado: qualquer
// usuário autenticado que descobrisse (não precisa adivinhar — vazamento de
// log, captura de tela, URL, etc.) o `operacao_id` de OUTRO colaborador
// conseguia ler os dados da marcação daquele colaborador (id, tipo, origem,
// horário, sinalização) enviando senha/foto/equipamento/nonce/assinatura
// completamente arbitrários — só precisava acertar o `tipo` (1 de 4
// valores possíveis). Isto nunca foi coberto por nenhum teste existente
// porque toda a suíte anterior chama equipamentoService diretamente,
// contornando exatamente o trecho de código onde este defeito vivia.
//
// Este teste prova que, APÓS a correção (filtro por usuario_id adicionado à
// consulta de idempotência), a mesma tentativa cai no fluxo normal de
// validação (senha) em vez de vazar a marcação de outro usuário.
test('troca de usuário via idempotência: a vítima não vaza sua marcação quando o atacante reenvia o operacao_id dela', async () => {
  const { usuario: vitima, token: tokenVitima } = await criarColaboradorHabilitado()
  const { token: tokenAtacante } = await criarColaboradorHabilitado()
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante(vitima)
  const operacaoIdDaVitima = crypto.randomUUID()

  const { resMarcacao: primeira } = await marcarViaHttp({
    token: tokenVitima, usuario: vitima, equipamentoId, privateKey, tipo: 'entrada', operacaoId: operacaoIdDaVitima,
  })
  assert.equal(primeira.status, 201)

  // Atacante (autenticado como si mesmo, nunca como a vítima) tenta
  // reenviar o MESMO operacao_id da vítima, com o MESMO tipo (só 4 valores
  // possíveis — fácil de acertar), mas senha/foto/equipamento/nonce/
  // assinatura ARBITRÁRIOS — exatamente o que alguém que só descobriu o
  // operacao_id (não a senha nem a chave do equipamento da vítima)
  // conseguiria montar.
  const tentativaAtacante = await chamar('POST', '/api/ponto/marcacoes', {
    token: tokenAtacante,
    body: {
      operacao_id: operacaoIdDaVitima,
      tipo: 'entrada',
      senha_atual: 'senha-completamente-errada-de-proposito',
      foto_base64: Buffer.from('foto-arbitraria-do-atacante').toString('base64'),
      mime_type: 'image/jpeg',
      equipamento_id: crypto.randomUUID(), // nem precisa existir
      nonce: 'nonce-arbitrario-do-atacante',
      assinatura: 'assinatura-arbitraria-do-atacante',
    },
  })

  assert.notEqual(tentativaAtacante.status, 200, 'o atacante NUNCA pode receber 200 (sucesso/idempotente) para a marcação da vítima')
  assert.equal(tentativaAtacante.status, 401, 'sem filtrar por usuario_id, a tentativa deveria cair no fluxo normal e falhar na senha (401) — não vazar o registro da vítima')
  assert.ok(!('origem' in (tentativaAtacante.body || {})), 'a resposta ao atacante nunca deveria conter campos da marcação da vítima (origem)')
  assert.ok(!('registrado_em' in (tentativaAtacante.body || {})), 'a resposta ao atacante nunca deveria conter campos da marcação da vítima (registrado_em)')
})

// Confirma que a correção acima (filtro por usuario_id) não quebrou a
// idempotência LEGÍTIMA: o próprio usuário reenviando seu próprio
// operacao_id (retry de timeout/duplo clique) continua recebendo 200
// idempotente, sem reprocessar senha/assinatura.
test('idempotência legítima preservada: o próprio usuário reenviando seu operacao_id continua recebendo 200 idempotente', async () => {
  const { usuario, token } = await criarColaboradorHabilitado()
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante(usuario)
  const operacaoId = crypto.randomUUID()

  const { resMarcacao: primeira } = await marcarViaHttp({ token, usuario, equipamentoId, privateKey, tipo: 'saida', operacaoId })
  assert.equal(primeira.status, 201)

  // Reenvio real do mesmo usuário, simulando um retry de timeout — senha e
  // assinatura nem importam mais aqui (é exatamente o comportamento
  // documentado: idempotência real não reprocessa a segunda tentativa).
  const segunda = await chamar('POST', '/api/ponto/marcacoes', {
    token,
    body: {
      operacao_id: operacaoId, tipo: 'saida', senha_atual: 'nao-importa-mais-nesta-segunda-chamada',
      foto_base64: Buffer.from('irrelevante').toString('base64'), mime_type: 'image/jpeg',
      equipamento_id: equipamentoId, nonce: 'irrelevante', assinatura: 'irrelevante',
    },
  })
  assert.equal(segunda.status, 200)
  assert.equal(segunda.body.idempotente, true)
  assert.equal(segunda.body.id, primeira.body.id)
})

test('replay real via HTTP: reenviar o mesmo nonce consumido com um operacao_id novo é rejeitado (409)', async () => {
  const { usuario, token } = await criarColaboradorHabilitado()
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante(usuario)
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')

  const operacaoId1 = crypto.randomUUID()
  const { resDesafio, resMarcacao } = await marcarViaHttp({ token, usuario, equipamentoId, privateKey, tipo: 'entrada', operacaoId: operacaoId1 })
  assert.equal(resMarcacao.status, 201)

  // Reaproveita o MESMO nonce (já consumido) com um operacao_id novo — o
  // equipamento de verdade assina de novo (tem a chave privada), simulando
  // um replay de rede/captura, não uma falsificação de assinatura. Foto
  // sintética válida (magic bytes JPEG) para passar por validarFotoBuffer
  // antes mesmo de chegar na checagem de nonce.
  const fotoReplayBase64 = fotoSinteticaBase64({ tamanhoBytes: 210 })
  const hash = calcularHashConteudo(Buffer.from(fotoReplayBase64, 'base64'))
  const operacaoId2 = crypto.randomUUID()
  const payload2 = payloadAssinaturaEquipamento({ nonce: resDesafio.body.nonce, equipamentoId, usuarioId: usuario.id, operacaoId: operacaoId2, tipo: 'entrada', hashConteudo: hash })
  const assinatura2 = assinar(privateKey, payload2)

  const tentativaReplay = await chamar('POST', '/api/ponto/marcacoes', {
    token,
    body: {
      operacao_id: operacaoId2, tipo: 'entrada', senha_atual: usuario.senha,
      foto_base64: fotoReplayBase64, mime_type: 'image/jpeg',
      equipamento_id: equipamentoId, nonce: resDesafio.body.nonce, assinatura: assinatura2,
    },
  })
  assert.equal(tentativaReplay.status, 409, 'nonce já consumido deveria ser rejeitado (desafio_ja_usado -> 409) mesmo via HTTP real')

  const { count } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId2)
  assert.equal(count, 0, 'nenhuma segunda marcação deveria ter sido criada a partir do nonce reaproveitado')
})

test('desafio expirado via HTTP real: assinatura válida sobre um desafio emitido pela rota, mas já expirado, é rejeitada (410)', async () => {
  const { usuario, token } = await criarColaboradorHabilitado()
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante(usuario)
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')

  const fotoBase64 = fotoSinteticaBase64({ tamanhoBytes: 205 })
  const hash = calcularHashConteudo(Buffer.from(fotoBase64, 'base64'))
  const resDesafio = await chamar('POST', '/api/ponto/desafios', {
    token,
    body: { equipamento_id: equipamentoId, tipo: 'entrada', hash_conteudo: hash },
  })
  assert.equal(resDesafio.status, 201)

  // O desafio foi emitido pela rota real — só forçamos o relógio dele pra
  // trás no banco, para simular a passagem do tempo sem esperar 60s de
  // verdade no teste.
  await supabase.from('ponto_desafios').update({ expira_em: new Date(Date.now() - 5000).toISOString() }).eq('nonce', resDesafio.body.nonce)

  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: resDesafio.body.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  const tentativa = await chamar('POST', '/api/ponto/marcacoes', {
    token,
    body: {
      operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuario.senha,
      foto_base64: fotoBase64, mime_type: 'image/jpeg',
      equipamento_id: equipamentoId, nonce: resDesafio.body.nonce, assinatura,
    },
  })
  assert.equal(tentativa.status, 410, 'desafio expirado deveria ser rejeitado (410) mesmo com assinatura genuína e via HTTP real')
})

test('chave revogada via HTTP real: equipamento revogado entre o desafio e a marcação é rejeitado (403), mesmo com assinatura genuína', async () => {
  const { usuario, token } = await criarColaboradorHabilitado()
  const { equipamentoId, privateKey } = await montarEquipamentoAssinante(usuario)
  const { calcularHashConteudo, payloadAssinaturaEquipamento } = await import('../../../src/lib/ponto/assinaturaEquipamento.js')

  const fotoBase64 = fotoSinteticaBase64({ tamanhoBytes: 208 })
  const hash = calcularHashConteudo(Buffer.from(fotoBase64, 'base64'))
  const resDesafio = await chamar('POST', '/api/ponto/desafios', {
    token,
    body: { equipamento_id: equipamentoId, tipo: 'entrada', hash_conteudo: hash },
  })
  assert.equal(resDesafio.status, 201)

  await revogarEquipamentoDeTeste(equipamentoId)

  const operacaoId = crypto.randomUUID()
  const payload = payloadAssinaturaEquipamento({ nonce: resDesafio.body.nonce, equipamentoId, usuarioId: usuario.id, operacaoId, tipo: 'entrada', hashConteudo: hash })
  const assinatura = assinar(privateKey, payload)

  const tentativa = await chamar('POST', '/api/ponto/marcacoes', {
    token,
    body: {
      operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuario.senha,
      foto_base64: fotoBase64, mime_type: 'image/jpeg',
      equipamento_id: equipamentoId, nonce: resDesafio.body.nonce, assinatura,
    },
  })
  assert.equal(tentativa.status, 403, 'equipamento revogado deveria ser rejeitado (403) mesmo com assinatura genuína e via HTTP real')

  const { count } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('operacao_id', operacaoId)
  assert.equal(count, 0)
})

test('troca de equipamento via HTTP real: outro usuário não consegue pedir desafio para um equipamento que não é seu', async () => {
  const { usuario: dono } = await criarColaboradorHabilitado()
  const { token: tokenOutro } = await criarColaboradorHabilitado()
  const { equipamentoId } = await montarEquipamentoAssinante(dono)

  const tentativa = await chamar('POST', '/api/ponto/desafios', {
    token: tokenOutro,
    body: { equipamento_id: equipamentoId, tipo: 'entrada', hash_conteudo: 'a'.repeat(64) },
  })
  assert.equal(tentativa.status, 403, 'outro usuário não deveria conseguir emitir desafio para um equipamento que não é seu')

  const { count } = await supabase.from('ponto_desafios').select('id', { count: 'exact', head: true }).eq('equipamento_id', equipamentoId)
  assert.equal(count, 0)
})
