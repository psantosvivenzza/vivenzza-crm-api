// Auditoria adversarial independente, follow-up do achado relacionado
// documentado pela auditoria da PR #81 (revisão do componente de
// equipamento): a busca idempotente de POST /api/ponto/solicitacoes
// filtrava só por operacao_id, sem exigir usuario_id = req.user.id.
//
// Como o retorno antecipado acontece ANTES da verificação de senha, isso
// permitia dois ataques a um atacante autenticado (qualquer colaborador
// habilitado) que descobrisse (log, captura de tela, URL, retry visível no
// devtools) o operacao_id de outro colaborador — sem precisar da senha
// correta de ninguém:
//
//   1. Reutilização/leitura: se tipo e justificativa coincidissem
//      exatamente com os da vítima, a resposta 200 devolvia o id e o
//      status da solicitação ALHEIA como se fosse a do próprio atacante.
//   2. Oráculo de existência: mesmo sem acertar tipo/justificativa, a
//      resposta 409 ("conteúdo diferente") já confirmava que aquele
//      operacao_id pertencia a alguém, vazando esse fato sem senha válida.
//
// Mesmo padrão já corrigido em POST /marcacoes pela PR #81
// (scripts/tests/ponto/auditoria-adversarial-equipamento-http.test.mjs);
// esta PR trata só POST /solicitacoes, separada e pequena por instrução do
// projeto (não misturar domínios/PRs).
//
// Reproduzido via HTTP real (chamar(), nunca camada de serviço direta)
// contra o código NÃO corrigido antes de qualquer alteração em
// src/routes/ponto.js: os dois primeiros testes abaixo falhavam (200/409
// vazando id/status/existência da vítima, sem senha correta do atacante).
// Depois da correção (.eq('usuario_id', req.user.id) na consulta de
// idempotência), os mesmos testes passam.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste,
} from './_setup.mjs'

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

test('troca de usuário via idempotência: atacante não lê nem reutiliza a solicitação da vítima quando tipo+justificativa coincidem, mesmo com senha errada', async () => {
  const vitima = await novoColaborador()
  const atacante = await novoColaborador()
  const operacaoId = crypto.randomUUID()
  const tipo = 'entrada'
  const justificativa = 'esqueci de bater o ponto às 8h por causa do trânsito'

  const original = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(vitima),
    body: { operacao_id: operacaoId, tipo, senha_atual: vitima.senha, justificativa },
  })
  assert.equal(original.status, 201)

  // Atacante "descobriu" o operacao_id e o tipo/justificativa exatos da
  // vítima (log, captura de tela, URL) — mas envia a PRÓPRIA senha errada
  // de propósito, para provar que o bug nem chegava a checar senha alguma.
  const ataque = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(atacante),
    body: { operacao_id: operacaoId, tipo, senha_atual: 'senha-completamente-arbitraria', justificativa },
  })

  assert.equal(ataque.status, 401, `esperava 401 (idempotência não pode enxergar solicitação de outro usuário) — veio ${ataque.status}: ${JSON.stringify(ataque.body)}`)
  assert.equal(ataque.body.id, undefined, 'a resposta ao atacante não pode conter o id da solicitação da vítima')
  assert.equal(ataque.body.status, undefined, 'a resposta ao atacante não pode conter o status da solicitação da vítima')
  assert.equal(ataque.body.idempotente, undefined, 'a resposta ao atacante não pode alegar idempotência sobre a operação da vítima')

  const supabase = obterSupabaseDeTeste()
  const { data: linhas } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .select('id, usuario_id')
    .eq('operacao_id', operacaoId)
  assert.equal(linhas.length, 1, 'o ataque não pode ter criado uma segunda linha')
  assert.equal(linhas[0].usuario_id, vitima.id, 'a única linha continua pertencendo à vítima')
  assert.equal(linhas[0].id, original.body.id)
})

test('oráculo de existência entre usuários: operacao_id alheio com conteúdo DIFERENTE não pode ser confirmado sem senha correta do atacante', async () => {
  const vitima = await novoColaborador()
  const atacante = await novoColaborador()
  const operacaoId = crypto.randomUUID()

  const original = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(vitima),
    body: { operacao_id: operacaoId, tipo: 'entrada', senha_atual: vitima.senha, justificativa: 'justificativa original da vítima' },
  })
  assert.equal(original.status, 201)

  const ataque = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(atacante),
    body: { operacao_id: operacaoId, tipo: 'saida', senha_atual: 'senha-errada-do-atacante', justificativa: 'tentativa de adivinhação' },
  })

  assert.notEqual(ataque.status, 409, 'o atacante não pode aprender, via 409, que este operacao_id já existe para outro usuário, sem senha correta')
  assert.equal(ataque.status, 401, `esperava 401 (senha do atacante está errada, caiu no fluxo normal de criação) — veio ${ataque.status}: ${JSON.stringify(ataque.body)}`)
})

test('regressão: idempotência legítima do próprio usuário continua funcionando após a correção', async () => {
  const usuario = await novoColaborador()
  const operacaoId = crypto.randomUUID()
  const corpo = { operacao_id: operacaoId, tipo: 'saida', senha_atual: usuario.senha, justificativa: 'mesma tentativa, reenviada pelo próprio usuário' }

  const primeira = await chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo })
  assert.equal(primeira.status, 201)

  const segunda = await chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo })
  assert.equal(segunda.status, 200)
  assert.equal(segunda.body.id, primeira.body.id)
  assert.equal(segunda.body.idempotente, true)
})

test('concorrência real entre usuários diferentes reivindicando o MESMO operacao_id: nenhum vaza nem lê a solicitação do outro', async () => {
  const usuarioA = await novoColaborador()
  const usuarioB = await novoColaborador()
  const operacaoId = crypto.randomUUID()

  const [respA, respB] = await Promise.all([
    chamar('POST', '/api/ponto/solicitacoes', {
      token: gerarToken(usuarioA),
      body: { operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuarioA.senha, justificativa: 'tentativa concorrente A' },
    }),
    chamar('POST', '/api/ponto/solicitacoes', {
      token: gerarToken(usuarioB),
      body: { operacao_id: operacaoId, tipo: 'entrada', senha_atual: usuarioB.senha, justificativa: 'tentativa concorrente B' },
    }),
  ])

  const supabase = obterSupabaseDeTeste()
  const { data: linhas } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .select('id, usuario_id')
    .eq('operacao_id', operacaoId)
  assert.equal(linhas.length, 1, 'o UNIQUE INDEX real do Postgres em operacao_id garante que só uma das duas corridas grava a linha, mesmo com a idempotência agora escopada por usuario_id')

  const vencedorId = linhas[0].usuario_id
  const [respVencedor, respPerdedor] = vencedorId === usuarioA.id ? [respA, respB] : [respB, respA]
  assert.equal(respVencedor.status, 201)
  assert.equal(respPerdedor.status, 500, `o perdedor da corrida entre usuários diferentes deve falhar explicitamente (conflito de UNIQUE global em operacao_id), nunca ler/reutilizar a linha do vencedor — veio ${respPerdedor.status}: ${JSON.stringify(respPerdedor.body)}`)
  assert.notEqual(respPerdedor.body?.id, linhas[0].id, 'a resposta do perdedor não pode conter o id da solicitação do vencedor')
})
