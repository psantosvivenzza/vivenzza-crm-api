// Auditoria adversarial independente da PR #78, motivada pelo achado da PR
// frontend vivenzza-crm-frontend#19: POST /api/ponto/correcoes não usava
// operacao_id nem exigirPilotoAtivo, ao contrário de /marcacoes e
// /solicitacoes.
//
// Reprodução confirmou dois riscos técnicos distintos — só o primeiro é um
// defeito real, corrigido nesta PR:
//
//   1. DUPLICAÇÃO SOB RETRY/CONCORRÊNCIA (defeito técnico real, corrigido
//      aqui): ao contrário de /marcacoes e /solicitacoes, ponto_correcoes
//      nasceu SEM operacao_id — nenhuma defesa de banco contra reenvio.
//      Reproduzido via HTTP real contra o código NÃO corrigido, antes de
//      qualquer alteração: 2 chamadas sequenciais idênticas (retry de rede
//      simulado) geravam 2 linhas; 5 chamadas simultâneas idênticas
//      geravam 5 linhas. Corrigido com o MESMO padrão de operacao_id +
//      UNIQUE real das duas rotas irmãs (migration 048 revisada), já
//      incluindo desde o início o filtro por usuario_id na consulta de
//      idempotência (classe de vazamento entre usuários corrigida nas PRs
//      #81/#82 para /marcacoes e /solicitacoes — não reintroduzida aqui).
//
//   2. AUSÊNCIA DE exigirPilotoAtivo NA CRIAÇÃO DE CORREÇÃO (investigado,
//      NÃO é defeito — decisão de negócio já documentada): a seção 4
//      (Permissões) de docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md lista
//      "solicitar correção" como capacidade do colaborador habilitado SEM
//      a condicional "(se piloto_ativo = true)" que aparece explicitamente
//      só para "enviar solicitação de marcação". A tabela de
//      ponto_solicitacoes_marcacao/ponto_marcacoes (seção 2.3) também só
//      cita "marcação (...) ou solicitação" ao definir o escopo da
//      idempotência por operacao_id — nunca "correção". Reproduzido: com
//      piloto_ativo=false, POST /correcoes continua 201. Este teste
//      documenta o comportamento ATUAL como uma REGRA DE PRODUTO já
//      especificada (colaborador pode pedir correção de um registro já
//      confirmado mesmo com o piloto pausado, para não travar acerto de
//      histórico antigo) — não foi alterado nem deveria ser sem decisão de
//      negócio explícita. O frontend (PR #19) já implementou o botão
//      "Solicitar correção" sempre habilitado, consistente com isto.
//
// Também revalidados nesta auditoria e confirmados SEM defeito (código já
// correto, sem alteração): correção de marcação alheia (marcacao_id de
// outro usuário sempre 404, nunca 201), payload forjado (status/
// decidido_por/usuario_id/solicitado_por/marcacao_gerada_id no corpo são
// sempre ignorados — valores vêm só de req.user.id e de literais no
// servidor) e usuário inativo (403 via exigirUsuarioAtivo, montado antes
// deste router em src/index.js — já coberto também por
// usuario-inativo-todas-rotas.test.mjs). Ver
// docs/meu-ponto/AUDITORIA_CORRECOES_DUPLICACAO_2026-09-12.md.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, limparVinculosCircularesDeTeste,
} from './_setup.mjs'

const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_correcoes').delete().in('usuario_id', criados)
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

async function marcacaoFixture(usuario, tipo = 'entrada') {
  const supabase = obterSupabaseDeTeste()
  const dia = new Date().toISOString().slice(0, 10)
  const { data: sol, error: e1 } = await supabase.from('ponto_solicitacoes_marcacao').insert({
    operacao_id: crypto.randomUUID(), usuario_id: usuario.id, tipo, motivo: 'outro',
    justificativa: 'fixture auditoria duplicação', dia_brt: dia, status: 'aprovada',
  }).select('id').single()
  if (e1) throw e1
  const { data, error } = await supabase.from('ponto_marcacoes').insert({
    operacao_id: crypto.randomUUID(), usuario_id: usuario.id, tipo, origem: 'contingencia',
    dia_brt: dia, justificativa_contingencia: 'fixture auditoria duplicação', origem_solicitacao_id: sol.id,
  }).select('id').single()
  if (error) throw error
  return data.id
}

test('operacao_id é obrigatório e precisa ser UUID', async () => {
  const usuario = await novoColaborador()
  const marcacaoId = await marcacaoFixture(usuario)

  const semOperacaoId = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(usuario),
    body: { marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste' },
  })
  assert.equal(semOperacaoId.status, 400)
  assert.match(semOperacaoId.body.erro, /operacao_id/)

  const operacaoIdInvalido = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(usuario),
    body: { operacao_id: 'não-é-um-uuid', marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste' },
  })
  assert.equal(operacaoIdInvalido.status, 400)
})

test('idempotência real: retry sequencial (mesmo operacao_id + MESMO conteúdo) devolve a MESMA correção, não cria uma segunda', async () => {
  const usuario = await novoColaborador()
  const marcacaoId = await marcacaoFixture(usuario, 'saida')
  const operacaoId = crypto.randomUUID()
  const body = { operacao_id: operacaoId, marcacao_id: marcacaoId, tipo_solicitacao: 'ajuste_horario', valor_proposto: { tipo: 'saida', registrado_em: new Date().toISOString() }, justificativa: 'corrigir horário de saída' }

  const primeira = await chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuario), body })
  assert.equal(primeira.status, 201)

  // "Retry" idêntico — simula timeout ambíguo/duplo clique do cliente.
  const retry = await chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuario), body })
  assert.equal(retry.status, 200, `esperava 200 idempotente — veio ${retry.status}: ${JSON.stringify(retry.body)}`)
  assert.equal(retry.body.id, primeira.body.id)
  assert.equal(retry.body.idempotente, true)

  const supabase = obterSupabaseDeTeste()
  const { data: linhas } = await supabase.from('ponto_correcoes').select('id').eq('operacao_id', operacaoId)
  assert.equal(linhas.length, 1, 'retry sequencial idêntico nunca pode criar uma segunda linha')
})

test('idempotência real: reenvio do mesmo operacao_id com conteúdo DIFERENTE é 409, nunca aceito silenciosamente', async () => {
  const usuario = await novoColaborador()
  const marcacaoId = await marcacaoFixture(usuario, 'entrada')
  const operacaoId = crypto.randomUUID()

  const original = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(usuario),
    body: { operacao_id: operacaoId, marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: { nota: 'primeira versão' }, justificativa: 'justificativa original' },
  })
  assert.equal(original.status, 201)

  const conteudoDiferente = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(usuario),
    body: { operacao_id: operacaoId, marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: { nota: 'versão alterada' }, justificativa: 'justificativa original' },
  })
  assert.equal(conteudoDiferente.status, 409)

  const supabase = obterSupabaseDeTeste()
  const { data: linhas } = await supabase.from('ponto_correcoes').select('id, valor_proposto').eq('operacao_id', operacaoId)
  assert.equal(linhas.length, 1)
  assert.equal(linhas[0].valor_proposto.nota, 'primeira versão', 'o conflito nunca pode sobrescrever o valor_proposto original')
})

test('concorrência real: N requisições HTTP simultâneas com o mesmo operacao_id geram exatamente 1 correção', async () => {
  const usuario = await novoColaborador()
  const marcacaoId = await marcacaoFixture(usuario, 'entrada')
  const operacaoId = crypto.randomUUID()
  const body = { operacao_id: operacaoId, marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: { nota: 'concorrência' }, justificativa: 'teste concorrência real' }

  const respostas = await Promise.all(Array.from({ length: 5 }, () => chamar('POST', '/api/ponto/correcoes', { token: gerarToken(usuario), body })))
  for (const r of respostas) assert.ok([200, 201].includes(r.status), `esperava 200/201 em toda resposta concorrente — veio ${r.status}: ${JSON.stringify(r.body)}`)

  const idsRetornados = new Set(respostas.map((r) => r.body.id))
  assert.equal(idsRetornados.size, 1, 'todas as respostas concorrentes devem apontar pro mesmo id')

  const supabase = obterSupabaseDeTeste()
  const { data: linhas } = await supabase.from('ponto_correcoes').select('id').eq('operacao_id', operacaoId)
  assert.equal(linhas.length, 1, 'UNIQUE INDEX real do Postgres em operacao_id garante isso mesmo sob corrida de verdade, não só checagem prévia em JS')
})

test('idempotência não vaza entre usuários: operacao_id de outro colaborador nunca é lido nem reutilizado (colisão real de UUID entre usuários é fail-closed, mesmo tratamento já aceito para /marcacoes e /solicitacoes nas PRs #81/#82)', async () => {
  const vitima = await novoColaborador()
  const atacante = await novoColaborador()
  const marcacaoVitima = await marcacaoFixture(vitima, 'entrada')
  const marcacaoAtacante = await marcacaoFixture(atacante, 'entrada')
  const operacaoId = crypto.randomUUID()

  const original = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(vitima),
    body: { operacao_id: operacaoId, marcacao_id: marcacaoVitima, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'justificativa da vítima' },
  })
  assert.equal(original.status, 201)

  // Atacante "descobriu" (log, captura de tela, URL) o operacao_id da
  // vítima e tenta reutilizá-lo referenciando a PRÓPRIA marcação. A
  // consulta de idempotência é escopada por usuario_id desde o primeiro
  // commit desta correção (não reintroduz a classe de vazamento corrigida
  // nas PRs #81/#82) — então o atacante NUNCA lê nem herda a linha da
  // vítima (nem 200 com id/status alheios, nem 409 confirmando existência
  // alheia). operacao_id em si é UNIQUE global (mesmo padrão de
  // ponto_marcacoes/ponto_solicitacoes_marcacao) — colidir com um UUID já
  // usado por OUTRO usuário é uma colisão real de UUID (praticamente
  // impossível em uso legítimo, já que o cliente gera um v4 aleatório por
  // toque) e falha explicitamente (500), nunca silenciosamente.
  const tentativa = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(atacante),
    body: { operacao_id: operacaoId, marcacao_id: marcacaoAtacante, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'justificativa do atacante' },
  })
  assert.equal(tentativa.status, 500, `esperava 500 (colisão real de UNIQUE global, fail-closed) — veio ${tentativa.status}: ${JSON.stringify(tentativa.body)}`)
  assert.equal(tentativa.body.id, undefined, 'a resposta ao atacante não pode conter o id da correção da vítima')
  assert.equal(tentativa.body.idempotente, undefined, 'a resposta ao atacante não pode alegar idempotência sobre a operação da vítima')

  const supabase = obterSupabaseDeTeste()
  const { data: linhas } = await supabase.from('ponto_correcoes').select('id, usuario_id').eq('operacao_id', operacaoId)
  assert.equal(linhas.length, 1, 'a tentativa do atacante não pode ter criado nem sobrescrito nenhuma linha')
  assert.equal(linhas[0].usuario_id, vitima.id, 'a única linha continua pertencendo à vítima')
  assert.equal(linhas[0].id, original.body.id)
})

test('correção de marcação alheia continua bloqueada (404) — revalidado, sem alteração de comportamento', async () => {
  const colaboradorA = await novoColaborador()
  const colaboradorB = await novoColaborador()
  const marcacaoDeB = await marcacaoFixture(colaboradorB, 'entrada')

  const tentativa = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(colaboradorA),
    body: { operacao_id: crypto.randomUUID(), marcacao_id: marcacaoDeB, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'tentativa de corrigir marcação alheia' },
  })
  assert.equal(tentativa.status, 404)

  const supabase = obterSupabaseDeTeste()
  const { data: linhas } = await supabase.from('ponto_correcoes').select('id').eq('marcacao_id', marcacaoDeB)
  assert.equal(linhas.length, 0)
})

test('payload forjado (status/decidido_por/usuario_id/solicitado_por/marcacao_gerada_id) é sempre ignorado — revalidado, sem alteração de comportamento', async () => {
  const usuario = await novoColaborador()
  const outro = await novoColaborador()
  const marcacaoId = await marcacaoFixture(usuario, 'saida_intervalo')

  const r = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(usuario),
    body: {
      operacao_id: crypto.randomUUID(), marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste payload forjado',
      status: 'aprovada', decidido_por: outro.id, decidido_em: new Date().toISOString(),
      usuario_id: outro.id, solicitado_por: outro.id, marcacao_gerada_id: '00000000-0000-0000-0000-000000000000',
    },
  })
  assert.equal(r.status, 201)

  const supabase = obterSupabaseDeTeste()
  const { data: linha } = await supabase.from('ponto_correcoes').select('*').eq('id', r.body.id).single()
  assert.equal(linha.status, 'pendente')
  assert.equal(linha.usuario_id, usuario.id)
  assert.equal(linha.solicitado_por, usuario.id)
  assert.equal(linha.decidido_por, null)
  assert.equal(linha.marcacao_gerada_id, null)
})

// Investigado e confirmado como regra de produto já especificada (ver
// cabeçalho do arquivo) — NÃO é o defeito técnico corrigido nesta PR, e o
// comportamento abaixo não foi alterado. Documentado como teste de
// regressão intencional: se alguém adicionar exigirPilotoAtivo aqui sem
// uma decisão de negócio explícita, este teste falha e sinaliza a mudança.
test('criação de correção continua permitida com piloto_ativo=false (regra de produto documentada, não um defeito) — revalidado, sem alteração de comportamento', async () => {
  const usuario = await novoColaborador()
  const marcacaoId = await marcacaoFixture(usuario, 'entrada')

  await definirPilotoAtivoDeTeste(false)
  try {
    const r = await chamar('POST', '/api/ponto/correcoes', {
      token: gerarToken(usuario),
      body: { operacao_id: crypto.randomUUID(), marcacao_id: marcacaoId, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste piloto desativado' },
    })
    assert.equal(r.status, 201, 'ver docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md seção 4 — "solicitar correção" não é condicionada a piloto_ativo, diferente de "enviar solicitação de marcação"')
  } finally {
    await definirPilotoAtivoDeTeste(true)
  }
})
