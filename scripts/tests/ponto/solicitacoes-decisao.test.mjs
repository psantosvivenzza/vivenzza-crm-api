// Decisão do gestor sobre solicitações de marcação — o único jeito de uma
// tentativa virar uma linha real em ponto_marcacoes enquanto o equipamento
// não for verificável. Cobre: aprovação preserva o instante real da
// tentativa (não o da decisão), sempre sinalizada para revisão, rejeição
// não cria marcação, autoaprovação bloqueada, escopo do gestor respeitado,
// e decisão concorrente (duas chamadas simultâneas) só produz UM resultado
// válido — a outra falha, não "a última que chegou vence" silenciosamente.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste, fotoSinteticaBase64,
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
  // ponto_marcacoes <-> ponto_solicitacoes_marcacao se referenciam nos dois
  // sentidos (FK real dos dois lados, migration 050) — zera
  // marcacao_gerada_id antes de apagar, senão a FK bloqueia.
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

async function criarSolicitacao(usuario, { comFoto = true } = {}) {
  const corpo = { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste decisão' }
  if (comFoto) { corpo.foto_base64 = fotoSinteticaBase64(); corpo.mime_type = 'image/jpeg' }
  const { body } = await chamar('POST', '/api/ponto/solicitacoes', { token: gerarToken(usuario), body: corpo })
  return body
}

test('aprovar solicitação COM foto cria marcação origem=contingencia, sempre sinalizada, preservando o instante real da tentativa', async () => {
  const antesDaSolicitacao = Date.now()
  const solicitacao = await criarSolicitacao(colaborador, { comFoto: true })
  assert.equal(solicitacao.status, 'pendente')

  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'aprovada', decisao_justificativa: 'confere' },
  })
  assert.equal(decidir.status, 200)
  assert.ok(decidir.body.marcacao_gerada)
  assert.equal(decidir.body.marcacao_gerada.tipo, 'entrada')

  const supabase = obterSupabaseDeTeste()
  const { data: marcacao } = await supabase.from('ponto_marcacoes').select('*').eq('id', decidir.body.marcacao_gerada.id).single()
  assert.equal(marcacao.origem, 'contingencia')
  assert.equal(marcacao.sinalizado_para_revisao, true, 'toda marcação vinda de solicitação é sinalizada — é uma exceção por construção')
  assert.ok(marcacao.foto_id, 'a foto anexada na solicitação é preservada na marcação')
  const instanteRegistrado = new Date(marcacao.registrado_em).getTime()
  assert.ok(instanteRegistrado >= antesDaSolicitacao && instanteRegistrado <= Date.now(), 'registrado_em é o instante da TENTATIVA, não o da decisão do gestor')

  const { data: solicitacaoDepois } = await supabase.from('ponto_solicitacoes_marcacao').select('marcacao_gerada_id').eq('id', solicitacao.id).single()
  assert.equal(solicitacaoDepois.marcacao_gerada_id, marcacao.id, 'rastreabilidade solicitação -> marcação preservada')
})

test('aprovar solicitação SEM foto (contingência pura) cria marcação com foto_id nulo e justificativa preenchida', async () => {
  const solicitacao = await criarSolicitacao(colaborador, { comFoto: false })
  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'aprovada' },
  })
  assert.equal(decidir.status, 200)

  const supabase = obterSupabaseDeTeste()
  const { data: marcacao } = await supabase.from('ponto_marcacoes').select('*').eq('id', decidir.body.marcacao_gerada.id).single()
  assert.equal(marcacao.foto_id, null)
  assert.equal(marcacao.justificativa_contingencia, 'teste decisão')
})

test('rejeitar solicitação não cria marcação nenhuma', async () => {
  const solicitacao = await criarSolicitacao(colaborador, { comFoto: false })
  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'rejeitada', decisao_justificativa: 'sem evidência suficiente' },
  })
  assert.equal(decidir.status, 200)
  assert.equal(decidir.body.marcacao_gerada, null)
})

test('admin não pode decidir sobre a própria solicitação (autoaprovação bloqueada)', async () => {
  await habilitarPontoDeTeste(admin.id, true)
  const solicitacao = await criarSolicitacao(admin, { comFoto: false })
  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, {
    token: gerarToken(admin),
    body: { decisao: 'aprovada' },
  })
  assert.equal(decidir.status, 403)
  assert.match(decidir.body.erro, /própria/i)
})

test('gestor não decide solicitação de colaborador fora do seu escopo', async () => {
  const solicitacao = await criarSolicitacao(terceiroColaborador, { comFoto: false })
  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'aprovada' },
  })
  assert.equal(decidir.status, 404)
})

test('decisão concorrente: duas chamadas simultâneas na mesma solicitação — só uma resulta em decisão válida, a outra falha', async () => {
  const solicitacao = await criarSolicitacao(colaborador, { comFoto: false })
  // Segundo "gestor" pra decidir em paralelo: admin também tem escopo total.
  const [respostaGestor, respostaAdmin] = await Promise.all([
    chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } }),
    chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(admin), body: { decisao: 'rejeitada' } }),
  ])

  const sucessos = [respostaGestor, respostaAdmin].filter((r) => r.status === 200)
  const conflitos = [respostaGestor, respostaAdmin].filter((r) => r.status === 409)
  assert.equal(sucessos.length, 1, 'exatamente uma das duas decisões concorrentes deve valer')
  assert.equal(conflitos.length, 1, 'a outra deve falhar explicitamente (409), não silenciosamente')

  const supabase = obterSupabaseDeTeste()
  const { data: final } = await supabase.from('ponto_solicitacoes_marcacao').select('status, decidido_por').eq('id', solicitacao.id).single()
  assert.ok(['aprovada', 'rejeitada'].includes(final.status))
  // O status final tem que bater com QUEM venceu a corrida, não os dois.
  const vencedor = sucessos[0] === respostaGestor ? gestor.id : admin.id
  assert.equal(final.decidido_por, vencedor)
})

test('decidir a mesma solicitação de novo depois de já decidida falha (409), não sobrescreve a decisão', async () => {
  const solicitacao = await criarSolicitacao(colaborador, { comFoto: false })
  const primeira = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'rejeitada' } })
  assert.equal(primeira.status, 200)

  const segunda = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(segunda.status, 409)

  const supabase = obterSupabaseDeTeste()
  const { data } = await supabase.from('ponto_solicitacoes_marcacao').select('status').eq('id', solicitacao.id).single()
  assert.equal(data.status, 'rejeitada', 'a segunda tentativa não pode ter mudado o status')
})
