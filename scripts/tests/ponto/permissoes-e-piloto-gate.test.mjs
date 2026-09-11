// Cobre: habilitação por colaborador (não por role), gate mestre
// ponto_config.piloto_ativo, isolamento entre colaboradores (terceiro não
// acessa/marca em nome de outro), escopo de gestor (admin vê tudo, gestor só
// sua equipe, quem não tem escopo é bloqueado).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste,
  definirHabilitacaoDeTeste, revogarEscopoGestorDeTeste,
} from './_setup.mjs'

let colaborador, colaboradorHabilitado, outroColaborador, admin, gestorSemEscopo, gestorComEscopo, usuarioFinanceiro
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)

  colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  colaboradorHabilitado = await criarUsuarioDeTeste({ role: 'vendedor' })
  outroColaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  gestorSemEscopo = await criarUsuarioDeTeste({ role: 'vendedor' })
  gestorComEscopo = await criarUsuarioDeTeste({ role: 'vendedor' })
  usuarioFinanceiro = await criarUsuarioDeTeste({ role: 'financeiro' })
  criados.push(colaborador.id, colaboradorHabilitado.id, outroColaborador.id, admin.id, gestorSemEscopo.id, gestorComEscopo.id, usuarioFinanceiro.id)

  await habilitarPontoDeTeste(colaboradorHabilitado.id, true)
  await habilitarPontoDeTeste(outroColaborador.id, true)
  await concederEscopoGestorDeTeste({ gestorId: gestorComEscopo.id, colaboradorId: colaboradorHabilitado.id, concedidoPor: admin.id })
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  // ponto_marcacoes.origem_solicitacao_id referencia ponto_solicitacoes_marcacao
  // (FK só de mão única desde a migration 050) — apagar marcações primeiro.
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

test('colaborador SEM habilitação recebe 403 ao consultar /api/ponto/estado', async () => {
  const { status, body } = await chamar('GET', '/api/ponto/estado', { token: gerarToken(colaborador) })
  assert.equal(status, 403)
  assert.match(body.erro, /habilitado/i)
})

test('colaborador HABILITADO consegue consultar /api/ponto/estado', async () => {
  const { status, body } = await chamar('GET', '/api/ponto/estado', { token: gerarToken(colaboradorHabilitado) })
  assert.equal(status, 200)
  assert.equal(body.piloto_ativo, true)
})

test('com piloto_ativo=false, colaborador habilitado NÃO consegue criar solicitação (mas continua consultando histórico)', async () => {
  await definirPilotoAtivoDeTeste(false)
  try {
    const criar = await chamar('POST', '/api/ponto/solicitacoes', {
      token: gerarToken(colaboradorHabilitado),
      body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: colaboradorHabilitado.senha, justificativa: 'teste' },
    })
    assert.equal(criar.status, 403)
    assert.match(criar.body.erro, /desativado/i)

    const consultar = await chamar('GET', '/api/ponto/marcacoes', { token: gerarToken(colaboradorHabilitado) })
    assert.equal(consultar.status, 200, 'consulta do próprio histórico continua disponível mesmo com o piloto pausado')
  } finally {
    await definirPilotoAtivoDeTeste(true)
  }
})

test('não existe rota para um usuário consultar marcação/foto de outro colaborador por troca de id', async () => {
  // Insere a marcação de outroColaborador direto no banco (não pela API —
  // POST /marcacoes está bloqueado pelo gate de equipamento nesta etapa;
  // o que está sob teste aqui é a leitura, não a criação). origem=
  // contingencia exige uma solicitação de origem (migration 050) — cria-se
  // uma fixture já aprovada só para satisfazer a referência.
  const supabase = obterSupabaseDeTeste()
  const dia = new Date().toISOString().slice(0, 10)
  const { data: solicitacaoFixture, error: erroFixture } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .insert({ operacao_id: crypto.randomUUID(), usuario_id: outroColaborador.id, tipo: 'entrada', motivo: 'outro', justificativa: 'setup de teste', dia_brt: dia, status: 'aprovada' })
    .select('id')
    .single()
  if (erroFixture) throw erroFixture

  const { data: marcacaoDeOutro, error } = await supabase
    .from('ponto_marcacoes')
    .insert({ operacao_id: crypto.randomUUID(), usuario_id: outroColaborador.id, tipo: 'entrada', origem: 'contingencia', dia_brt: dia, justificativa_contingencia: 'setup de teste', origem_solicitacao_id: solicitacaoFixture.id })
    .select('id')
    .single()
  if (error) throw error

  // colaboradorHabilitado tenta ver a marcação/foto de outroColaborador — a
  // rota só existe sob /api/ponto (sempre req.user.id), então o id de
  // terceiro simplesmente não aparece na consulta própria.
  const listaPropria = await chamar('GET', '/api/ponto/marcacoes', { token: gerarToken(colaboradorHabilitado) })
  assert.ok(!listaPropria.body.itens.some((m) => m.id === marcacaoDeOutro.id), 'marcação de outro colaborador nunca aparece na listagem própria')

  const foto = await chamar('GET', `/api/ponto/marcacoes/${marcacaoDeOutro.id}/foto`, { token: gerarToken(colaboradorHabilitado) })
  assert.equal(foto.status, 404, 'tentar ler a foto de uma marcação de outro colaborador pelo id direto é bloqueado')
})

test('papel "financeiro" não vira gestor de ponto automaticamente', async () => {
  const { status, body } = await chamar('GET', '/api/ponto-gestao/colaboradores', { token: gerarToken(usuarioFinanceiro) })
  assert.equal(status, 403)
  assert.match(body.erro, /gestor/i)
})

test('revogar habilitação bloqueia o acesso imediatamente, mesmo com um JWT antigo (ainda válido) da mesma sessão', async () => {
  const usuario = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(usuario.id)
  await habilitarPontoDeTeste(usuario.id, true)
  const tokenAntigo = gerarToken(usuario) // emitido enquanto ainda estava habilitado

  const antes = await chamar('GET', '/api/ponto/estado', { token: tokenAntigo })
  assert.equal(antes.status, 200)

  await definirHabilitacaoDeTeste(usuario.id, false)

  const depois = await chamar('GET', '/api/ponto/estado', { token: tokenAntigo })
  assert.equal(depois.status, 403, 'o mesmo JWT (não expirado) não basta — a habilitação é checada no banco a cada requisição, não confiada no token')
})

test('revogar escopo de gestor bloqueia o acesso imediatamente, mesmo com JWT antigo', async () => {
  const gestorTemporario = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(gestorTemporario.id)
  await concederEscopoGestorDeTeste({ gestorId: gestorTemporario.id, colaboradorId: colaboradorHabilitado.id, concedidoPor: admin.id })
  const tokenAntigo = gerarToken(gestorTemporario)

  const antes = await chamar('GET', '/api/ponto-gestao/colaboradores', { token: tokenAntigo })
  assert.equal(antes.status, 200)

  await revogarEscopoGestorDeTeste({ gestorId: gestorTemporario.id, colaboradorId: colaboradorHabilitado.id })

  const depois = await chamar('GET', '/api/ponto-gestao/colaboradores', { token: tokenAntigo })
  assert.equal(depois.status, 403, 'escopo revogado bloqueia mesmo sem logout/novo login')
})

test('gestor sem vínculo em ponto_gestores é bloqueado em /api/ponto-gestao', async () => {
  const { status, body } = await chamar('GET', '/api/ponto-gestao/colaboradores', { token: gerarToken(gestorSemEscopo) })
  assert.equal(status, 403)
  assert.match(body.erro, /gestor/i)
})

test('gestor com escopo só vê o colaborador vinculado, não outro habilitado fora do escopo', async () => {
  const { status, body } = await chamar('GET', '/api/ponto-gestao/colaboradores', { token: gerarToken(gestorComEscopo) })
  assert.equal(status, 200)
  const ids = body.itens.map((c) => c.id)
  assert.ok(ids.includes(colaboradorHabilitado.id))
  assert.ok(!ids.includes(outroColaborador.id), 'colaborador fora do escopo do gestor não pode aparecer')
})

test('gestor não consegue consultar marcações de colaborador fora do seu escopo mesmo pedindo o id direto', async () => {
  const { status, body } = await chamar('GET', `/api/ponto-gestao/marcacoes?colaborador_id=${outroColaborador.id}`, { token: gerarToken(gestorComEscopo) })
  assert.equal(status, 403)
  assert.match(body.erro, /escopo/i)
})

test('admin vê todos os colaboradores habilitados, mesmo sem vínculo explícito em ponto_gestores', async () => {
  const { status, body } = await chamar('GET', '/api/ponto-gestao/colaboradores', { token: gerarToken(admin) })
  assert.equal(status, 200)
  const ids = body.itens.map((c) => c.id)
  assert.ok(ids.includes(colaboradorHabilitado.id))
  assert.ok(ids.includes(outroColaborador.id))
})

test('vendedor comum (não admin, não gestor) não acessa /api/ponto-admin', async () => {
  const { status } = await chamar('GET', '/api/ponto-admin/habilitacoes', { token: gerarToken(colaboradorHabilitado) })
  assert.equal(status, 403)
})

test('admin habilita um colaborador via /api/ponto-admin/habilitacoes e o efeito é imediato', async () => {
  const antes = await chamar('GET', '/api/ponto/estado', { token: gerarToken(colaborador) })
  assert.equal(antes.status, 403)

  const patch = await chamar('PATCH', `/api/ponto-admin/habilitacoes/${colaborador.id}`, {
    token: gerarToken(admin),
    body: { habilitado: true, observacao: 'teste automatizado' },
  })
  assert.equal(patch.status, 200)

  const depois = await chamar('GET', '/api/ponto/estado', { token: gerarToken(colaborador) })
  assert.equal(depois.status, 200)
})
