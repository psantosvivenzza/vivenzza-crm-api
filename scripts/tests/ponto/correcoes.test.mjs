// Cobre: solicitação de correção pelo colaborador, aprovação gera NOVA
// marcação (origem=correcao) preservando a original intacta, rejeição não
// gera marcação, bloqueio de autoaprovação (app + constraint do banco), e
// decisão fora do escopo do gestor é bloqueada.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste,
  limparVinculosCircularesDeTeste,
} from './_setup.mjs'

let colaborador, gestor, admin, terceiroColaborador
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)

  colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  terceiroColaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(colaborador.id, gestor.id, admin.id, terceiroColaborador.id)

  await habilitarPontoDeTeste(colaborador.id, true)
  await habilitarPontoDeTeste(terceiroColaborador.id, true)
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: colaborador.id, concedidoPor: admin.id })
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  // ponto_marcacoes <-> ponto_correcoes/ponto_solicitacoes_marcacao se
  // referenciam nos dois sentidos (FK real dos dois lados, migration 050)
  // — zera marcacao_gerada_id antes de apagar, senão a FK bloqueia.
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_correcoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

// Insere a marcação-base direto no banco — POST /api/ponto/marcacoes está
// bloqueado pelo gate de equipamento nesta etapa (ver
// equipamento-bloqueio.test.mjs); o que está sob teste aqui é o fluxo de
// CORREÇÃO sobre uma marcação já confirmada, não a criação dela. Toda
// marcação origem='contingencia' precisa referenciar uma solicitação
// (ponto_marcacoes_contingencia_exige_origem_solicitacao, migration 050) —
// cria-se aqui uma solicitação-fixture já "aprovada" só para satisfazer a
// referência, sem passar pelo endpoint real.
async function criarMarcacaoDeTeste(usuario, tipo = 'entrada') {
  const supabase = obterSupabaseDeTeste()
  const dia = new Date().toISOString().slice(0, 10)
  const { data: solicitacaoFixture, error: erroFixture } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      motivo: 'outro',
      justificativa: 'setup de teste (correções) — fixture já aprovada',
      dia_brt: dia,
      status: 'aprovada',
    })
    .select('id')
    .single()
  if (erroFixture) throw erroFixture

  const { data, error } = await supabase
    .from('ponto_marcacoes')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      origem: 'contingencia',
      dia_brt: dia,
      justificativa_contingencia: 'setup de teste (correções)',
      origem_solicitacao_id: solicitacaoFixture.id,
    })
    .select('id, tipo, origem, registrado_em, dia_brt')
    .single()
  if (error) throw error
  return data
}

test('correção aprovada gera nova marcação (origem=correcao) e NUNCA edita a original', async () => {
  const original = await criarMarcacaoDeTeste(colaborador, 'entrada')
  assert.ok(original.id)

  const horaCorrigida = new Date(Date.now() - 3600_000).toISOString()
  const solicitar = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(colaborador),
    body: {
      marcacao_id: original.id,
      tipo_solicitacao: 'ajuste_horario',
      valor_proposto: { tipo: 'entrada', registrado_em: horaCorrigida },
      justificativa: 'bati o ponto tarde, cheguei antes',
    },
  })
  assert.equal(solicitar.status, 201)
  assert.equal(solicitar.body.status, 'pendente')

  const decidir = await chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'aprovada', decisao_justificativa: 'confere com a portaria' },
  })
  assert.equal(decidir.status, 200)
  assert.ok(decidir.body.marcacao_gerada, 'aprovação de ajuste_horario deve gerar uma nova marcação')
  assert.equal(decidir.body.marcacao_gerada.tipo, 'entrada')

  const supabase = obterSupabaseDeTeste()
  const { data: originalDepois } = await supabase.from('ponto_marcacoes').select('*').eq('id', original.id).single()
  assert.equal(originalDepois.tipo, 'entrada')
  assert.equal(new Date(originalDepois.registrado_em).toISOString(), new Date(original.registrado_em).toISOString(), 'registrado_em original nunca muda')
  assert.equal(originalDepois.origem, original.origem, 'origem original nunca muda (não vira "correcao")')

  const { data: novaMarcacao } = await supabase.from('ponto_marcacoes').select('*').eq('id', decidir.body.marcacao_gerada.id).single()
  assert.equal(novaMarcacao.origem, 'correcao')
  assert.equal(novaMarcacao.origem_correcao_id, solicitar.body.id)
})

test('correção rejeitada não gera nenhuma marcação nova', async () => {
  const original = await criarMarcacaoDeTeste(colaborador, 'saida_intervalo')
  const solicitar = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(colaborador),
    body: { marcacao_id: original.id, tipo_solicitacao: 'ajuste_horario', valor_proposto: { tipo: 'saida_intervalo', registrado_em: new Date().toISOString() }, justificativa: 'teste' },
  })

  const decidir = await chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'rejeitada', decisao_justificativa: 'sem evidência suficiente' },
  })
  assert.equal(decidir.status, 200)
  assert.equal(decidir.body.marcacao_gerada, null)
})

test('admin não pode decidir sobre a própria solicitação (bloqueio de autoaprovação)', async () => {
  // Um gestor comum nunca tem escopo sobre si mesmo a menos que alguém
  // conceda explicitamente — então o cenário realista de autoaprovação é o
  // admin (único papel com escopo irrestrito, req.pontoEscopoGestor = null),
  // habilitado como colaborador, tentando decidir a própria solicitação.
  await habilitarPontoDeTeste(admin.id, true)
  const marcacaoDoAdmin = await criarMarcacaoDeTeste(admin, 'entrada')
  const solicitar = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(admin),
    body: { marcacao_id: marcacaoDoAdmin.id, tipo_solicitacao: 'outro', valor_proposto: { nota: 'teste' }, justificativa: 'teste autoaprovação' },
  })
  assert.equal(solicitar.status, 201)

  const decidir = await chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, {
    token: gerarToken(admin),
    body: { decisao: 'aprovada' },
  })
  assert.equal(decidir.status, 403)
  assert.match(decidir.body.erro, /própria/i)
})

test('gestor não pode decidir correção de colaborador fora do seu escopo', async () => {
  const marcacaoTerceiro = await criarMarcacaoDeTeste(terceiroColaborador, 'entrada')
  const solicitar = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(terceiroColaborador),
    body: { marcacao_id: marcacaoTerceiro.id, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste escopo' },
  })
  assert.equal(solicitar.status, 201)

  const decidir = await chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'aprovada' },
  })
  assert.equal(decidir.status, 404, 'fora do escopo se comporta como não encontrado, não vaza existência do registro')
})

test('decidir a mesma solicitação duas vezes falha na segunda (já decidida)', async () => {
  const marcacao = await criarMarcacaoDeTeste(colaborador, 'saida')
  const solicitar = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(colaborador),
    body: { marcacao_id: marcacao.id, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste dupla decisão' },
  })

  const primeira = await chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'rejeitada' } })
  assert.equal(primeira.status, 200)

  const segunda = await chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(segunda.status, 409)
})

test('decisão concorrente sobre a mesma correção: duas chamadas simultâneas, só uma vale', async () => {
  const marcacao = await criarMarcacaoDeTeste(colaborador, 'entrada')
  const solicitar = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(colaborador),
    body: { marcacao_id: marcacao.id, tipo_solicitacao: 'outro', valor_proposto: {}, justificativa: 'teste decisão concorrente' },
  })
  assert.equal(solicitar.status, 201)

  const [respostaGestor, respostaAdmin] = await Promise.all([
    chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } }),
    chamar('POST', `/api/ponto-gestao/correcoes/${solicitar.body.id}/decisao`, { token: gerarToken(admin), body: { decisao: 'rejeitada' } }),
  ])

  const sucessos = [respostaGestor, respostaAdmin].filter((r) => r.status === 200)
  const conflitos = [respostaGestor, respostaAdmin].filter((r) => r.status === 409)
  assert.equal(sucessos.length, 1, 'exatamente uma decisão concorrente deve valer')
  assert.equal(conflitos.length, 1, 'a outra falha explicitamente, não é silenciosamente ignorada nem sobrescreve')
})
