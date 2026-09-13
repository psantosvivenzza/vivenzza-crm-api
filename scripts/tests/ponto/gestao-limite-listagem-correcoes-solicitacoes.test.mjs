// Achado da auditoria adversarial de 2026-09-12 (fotos/histórico/
// exportação/gestão/admin sobre a pilha #78+#81+#82+#83): GET
// /api/ponto-gestao/correcoes e GET /api/ponto-gestao/solicitacoes nunca
// tiveram NENHUM limite de itens — diferente de GET /marcacoes (pagina/
// limite, teto de 500), um gestor com escopo amplo (ou um admin) recebia a
// tabela inteira dentro do escopo numa única resposta HTTP. Este arquivo
// prova que agora as duas rotas respeitam o mesmo teto (500) e devolvem
// pagina/limite/total, sem quebrar o formato de resposta existente
// (`itens` continua presente e continua respeitando o escopo do gestor).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste,
  limparVinculosCircularesDeTeste,
} from './_setup.mjs'

let admin, gestor, colaborador
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)

  admin = await criarUsuarioDeTeste({ role: 'admin' })
  gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(admin.id, gestor.id, colaborador.id)

  await habilitarPontoDeTeste(colaborador.id, true)
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: colaborador.id, concedidoPor: admin.id })
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_correcoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_fotos').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

let contadorFixture = 0
async function criarMarcacaoDeTeste(usuario, tipo = 'entrada') {
  const supabase = obterSupabaseDeTeste()
  contadorFixture += 1
  const dia = new Date().toISOString().slice(0, 10)
  const { data: solicitacaoFixture, error: erroFixture } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      motivo: 'outro',
      justificativa: `fixture de teste (limite de listagem) #${contadorFixture}`,
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
      justificativa_contingencia: 'fixture de teste (limite de listagem)',
      origem_solicitacao_id: solicitacaoFixture.id,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function criarCorrecaoPendente(usuario, marcacaoId) {
  const supabase = obterSupabaseDeTeste()
  contadorFixture += 1
  const { data, error } = await supabase
    .from('ponto_correcoes')
    .insert({
      marcacao_id: marcacaoId,
      usuario_id: usuario.id,
      tipo_solicitacao: 'outro',
      valor_proposto: { nota: `correcao-${contadorFixture}` },
      justificativa: `fixture de teste (limite de listagem) #${contadorFixture}`,
      solicitado_por: usuario.id,
      status: 'pendente',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function criarSolicitacaoPendente(usuario, tipo = 'saida') {
  const supabase = obterSupabaseDeTeste()
  contadorFixture += 1
  const { data, error } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      motivo: 'outro',
      justificativa: `fixture de teste (limite de listagem) #${contadorFixture}`,
      dia_brt: new Date().toISOString().slice(0, 10),
      status: 'pendente',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

test('GET /api/ponto-gestao/correcoes nunca excede o teto de 500 itens por página, mesmo pedindo um limite maior', async () => {
  const resposta = await chamar('GET', '/api/ponto-gestao/correcoes?limite=999999', { token: gerarToken(gestor) })
  assert.equal(resposta.status, 200)
  assert.equal(resposta.body.limite, 500, 'limite deveria ser sempre clampado em 500, nunca aceitar um valor maior do cliente')
})

test('GET /api/ponto-gestao/solicitacoes nunca excede o teto de 500 itens por página, mesmo pedindo um limite maior', async () => {
  const resposta = await chamar('GET', '/api/ponto-gestao/solicitacoes?limite=999999', { token: gerarToken(gestor) })
  assert.equal(resposta.status, 200)
  assert.equal(resposta.body.limite, 500, 'limite deveria ser sempre clampado em 500, nunca aceitar um valor maior do cliente')
})

test('GET /api/ponto-gestao/correcoes pagina corretamente (total/pagina/limite) sem perder nem duplicar itens dentro do escopo', async () => {
  const marcacaoA = await criarMarcacaoDeTeste(colaborador)
  const idA = await criarCorrecaoPendente(colaborador, marcacaoA)
  const marcacaoB = await criarMarcacaoDeTeste(colaborador)
  const idB = await criarCorrecaoPendente(colaborador, marcacaoB)
  const marcacaoC = await criarMarcacaoDeTeste(colaborador)
  const idC = await criarCorrecaoPendente(colaborador, marcacaoC)

  const pagina1 = await chamar('GET', '/api/ponto-gestao/correcoes?limite=2&pagina=1', { token: gerarToken(gestor) })
  const pagina2 = await chamar('GET', '/api/ponto-gestao/correcoes?limite=2&pagina=2', { token: gerarToken(gestor) })

  assert.equal(pagina1.status, 200)
  assert.equal(pagina2.status, 200)
  assert.equal(pagina1.body.itens.length, 2)
  assert.ok(pagina1.body.total >= 3, `total deveria contar pelo menos as 3 correções criadas, veio ${pagina1.body.total}`)
  assert.ok(pagina2.body.itens.length >= 1)

  const idsTotais = [...pagina1.body.itens, ...pagina2.body.itens].map((i) => i.id)
  assert.ok([idA, idB, idC].every((id) => idsTotais.includes(id)), 'as 3 correções criadas deveriam aparecer somando as páginas, sem serem perdidas pela paginação')
  assert.equal(new Set(idsTotais).size, idsTotais.length, 'nenhum item deveria se repetir entre páginas diferentes')
})

test('GET /api/ponto-gestao/solicitacoes continua bloqueando colaborador_id fora do escopo mesmo com o novo parâmetro de paginação', async () => {
  const outroColaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(outroColaborador.id)
  await habilitarPontoDeTeste(outroColaborador.id, true)
  await criarSolicitacaoPendente(outroColaborador)

  const resposta = await chamar('GET', `/api/ponto-gestao/solicitacoes?colaborador_id=${outroColaborador.id}&limite=500`, { token: gerarToken(gestor) })
  assert.equal(resposta.status, 403, 'a paginação nova não pode enfraquecer a checagem de escopo existente')
})

test('resposta de GET /api/ponto-gestao/correcoes continua trazendo `itens` (compatível com consumidores atuais) mesmo com os novos campos', async () => {
  const resposta = await chamar('GET', '/api/ponto-gestao/correcoes', { token: gerarToken(gestor) })
  assert.equal(resposta.status, 200)
  assert.ok(Array.isArray(resposta.body.itens), 'itens continua sendo um array, formato de resposta não quebrado')
  assert.equal(typeof resposta.body.total, 'number')
  assert.equal(typeof resposta.body.pagina, 'number')
  assert.equal(typeof resposta.body.limite, 'number')
})
