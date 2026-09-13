// Cobre os achados da revisão de 2026-09-10 (segunda rodada):
// - As três travas são distintas: marcação direta bloqueada por falta de
//   equipamento; solicitação manual PODE virar marcação após aprovação
//   humana (isso é o esperado); piloto desativado bloqueia solicitações
//   novas E decisões que produziriam marcação (mas não bloqueia rejeitar).
// - Aprovação é atômica de verdade (função Postgres, não dois passos em
//   JS) — falha real injetada via trigger prova que uma falha no INSERT da
//   marcação NUNCA deixa a solicitação "aprovada" sem marcação.
// - Proteção no banco (não só em JS) contra mais de uma marcação pra mesma
//   solicitação.
// - Retry após timeout recupera a decisão existente, não erra às cegas.
// - Gestor precisa continuar ativo (usuarios.ativo) no momento da decisão.
// - Colaborador não troca autor/horário recebido/status pelo payload.
// - horario_declarado é distinto de capturado_em/decidido_em e nunca vira
//   registrado_em da marcação.
//
// Cada teste usa um colaborador PRÓPRIO (não compartilhado) — o limite de
// tentativas (8/5min por usuário, ver limiteTentativasSensiveis em
// src/routes/ponto.js) e as contagens por usuario_id exigem isolamento
// entre testes, não um único colaborador reaproveitado o arquivo inteiro.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste, fotoSinteticaBase64,
  instalarFalhaForcadaDeInsert, removerFalhaForcadaDeInsert,
  limparVinculosCircularesDeTeste,
} from './_setup.mjs'

let gestor, admin
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)

  gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  criados.push(gestor.id, admin.id)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

async function novoColaborador() {
  const usuario = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(usuario.id)
  await habilitarPontoDeTeste(usuario.id, true)
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: usuario.id, concedidoPor: admin.id })
  return usuario
}

async function criarSolicitacao(usuario, extra = {}) {
  const { body } = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste', ...extra },
  })
  return body
}

test('as três travas são distintas: marcação direta bloqueada, solicitação aprovada CRIA marcação, piloto desativado bloqueia só o que produziria marcação', async () => {
  const colaborador = await novoColaborador()

  // 1. Marcação direta — bloqueada por falta de verificação de equipamento,
  // testado exaustivamente em equipamento-bloqueio.test.mjs; aqui só a
  // reafirmação de que o texto certo não é "toda marcação está bloqueada".
  const direta = await chamar('POST', '/api/ponto/marcacoes', {
    token: gerarToken(colaborador),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: colaborador.senha, foto_base64: fotoSinteticaBase64(), mime_type: 'image/jpeg' },
  })
  assert.equal(direta.status, 501)

  // 2. Solicitação + aprovação humana CRIA uma marcação de verdade — isso
  // não é um bug nem contradiz o gate de equipamento, é o design.
  const solicitacao = await criarSolicitacao(colaborador)
  const aprovar = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(aprovar.status, 200)
  assert.ok(aprovar.body.marcacao_gerada?.id, 'aprovação humana consegue criar marcação — EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false não impede isso')

  // 3. Piloto desativado — bloqueia aprovação de uma NOVA solicitação
  // pendente (não produz marcação), mas rejeitar continua permitido.
  const solicitacao2 = await criarSolicitacao(colaborador)
  await definirPilotoAtivoDeTeste(false)
  try {
    const aprovarComPilotoOff = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao2.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
    assert.equal(aprovarComPilotoOff.status, 403)
    assert.match(aprovarComPilotoOff.body.erro, /desativado/i)

    const rejeitarComPilotoOff = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao2.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'rejeitada' } })
    assert.equal(rejeitarComPilotoOff.status, 200, 'rejeitar nunca cria marcação, então continua permitido mesmo com o piloto pausado')
  } finally {
    await definirPilotoAtivoDeTeste(true)
  }
})

test('atomicidade real: falha injetada no INSERT da marcação durante a aprovação NÃO deixa a solicitação presa em "aprovada" sem marcação', async () => {
  const colaborador = await novoColaborador()
  const solicitacao = await criarSolicitacao(colaborador)
  instalarFalhaForcadaDeInsert('ponto_marcacoes')
  try {
    const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
    assert.equal(decidir.status, 500, 'a chamada tem que falhar explicitamente, nunca fingir sucesso')

    const supabase = obterSupabaseDeTeste()
    const { data: solicitacaoDepois } = await supabase.from('ponto_solicitacoes_marcacao').select('status, marcacao_gerada_id').eq('id', solicitacao.id).single()
    assert.equal(solicitacaoDepois.status, 'pendente', 'a transação inteira desfez — o UPDATE de status nunca comitou sozinho')
    assert.equal(solicitacaoDepois.marcacao_gerada_id, null)

    const { count } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('usuario_id', colaborador.id)
    assert.equal(count, 0, 'nenhuma marcação órfã')
  } finally {
    removerFalhaForcadaDeInsert('ponto_marcacoes')
  }

  // Depois de remover a falha, a MESMA solicitação (ainda pendente) pode
  // ser aprovada normalmente — prova que o estado ficou consistente e
  // recuperável, não corrompido.
  const decidirDeNovo = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(decidirDeNovo.status, 200)
  assert.ok(decidirDeNovo.body.marcacao_gerada?.id)
})

test('proteção no banco (não só em JS) contra mais de uma marcação pra mesma solicitação', async () => {
  const colaborador = await novoColaborador()
  const solicitacao = await criarSolicitacao(colaborador)
  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(decidir.status, 200)

  // Tenta inserir uma SEGUNDA marcação apontando pra mesma solicitação,
  // direto no banco (contornando a função) — o UNIQUE INDEX tem que
  // rejeitar, provando que a garantia não depende só da função chamar
  // certo.
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase.from('ponto_marcacoes').insert({
    operacao_id: crypto.randomUUID(),
    usuario_id: colaborador.id,
    tipo: 'entrada',
    origem: 'contingencia',
    dia_brt: new Date().toISOString().slice(0, 10),
    justificativa_contingencia: 'tentativa de duplicar',
    origem_solicitacao_id: solicitacao.id,
  })
  assert.ok(error, 'o banco tem que rejeitar — UNIQUE INDEX em origem_solicitacao_id')
  assert.equal(error.code, '23505')
})

test('retry após timeout recupera a decisão existente, não erra às cegas nem duplica', async () => {
  const colaborador = await novoColaborador()
  const solicitacao = await criarSolicitacao(colaborador)
  const primeira = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada', decisao_justificativa: 'ok' } })
  assert.equal(primeira.status, 200)
  const marcacaoOriginal = primeira.body.marcacao_gerada.id

  // Simula o gestor reenviando a mesma decisão após não ter certeza se a
  // primeira chamada chegou a confirmar (timeout de rede, por exemplo).
  const retry = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada', decisao_justificativa: 'ok' } })
  assert.equal(retry.status, 409)
  assert.equal(retry.body.status, 'aprovada')
  assert.equal(retry.body.marcacao_gerada_id, marcacaoOriginal, 'o retry devolve a MESMA marcação já criada, não cria outra')

  const supabase = obterSupabaseDeTeste()
  const { count } = await supabase.from('ponto_marcacoes').select('id', { count: 'exact', head: true }).eq('usuario_id', colaborador.id)
  assert.equal(count, 1)
})

test('gestor desativado (usuarios.ativo=false) não decide, mesmo com JWT ainda válido e escopo correto', async () => {
  const colaborador = await novoColaborador()
  const gestorTemporario = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(gestorTemporario.id)
  await concederEscopoGestorDeTeste({ gestorId: gestorTemporario.id, colaboradorId: colaborador.id, concedidoPor: admin.id })
  const token = gerarToken(gestorTemporario)

  const solicitacao = await criarSolicitacao(colaborador)

  const antes = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token, body: { decisao: 'rejeitada' } })
  assert.equal(antes.status, 200, 'enquanto ativo, decide normalmente')

  const solicitacao2 = await criarSolicitacao(colaborador)
  const supabase = obterSupabaseDeTeste()
  await supabase.from('usuarios').update({ ativo: false }).eq('id', gestorTemporario.id)

  const depois = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao2.id}/decisao`, { token, body: { decisao: 'aprovada' } })
  assert.equal(depois.status, 403, 'desativado bloqueia mesmo com o mesmo JWT e o mesmo escopo de antes')
})

test('colaborador não troca autor, horário recebido ou status pelo payload de /solicitacoes', async () => {
  const colaborador = await novoColaborador()
  const outroUsuario = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(outroUsuario.id)

  const horaForjada = new Date(Date.now() - 100000000).toISOString() // "capturado" há mais de 1 dia
  const { status, body } = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(colaborador),
    body: {
      operacao_id: crypto.randomUUID(),
      tipo: 'entrada',
      senha_atual: colaborador.senha,
      justificativa: 'tentativa de forjar campos',
      usuario_id: outroUsuario.id,
      status: 'aprovada',
      capturado_em: horaForjada,
      decidido_por: admin.id,
      decidido_em: horaForjada,
    },
  })
  assert.equal(status, 201)

  const supabase = obterSupabaseDeTeste()
  const { data } = await supabase.from('ponto_solicitacoes_marcacao').select('*').eq('id', body.id).single()
  assert.equal(data.usuario_id, colaborador.id, 'usuario_id sempre vem de req.user.id, nunca do corpo')
  assert.equal(data.status, 'pendente', 'status inicial é sempre pendente, nunca aceito do corpo')
  assert.equal(data.decidido_por, null)
  assert.notEqual(new Date(data.capturado_em).getTime(), new Date(horaForjada).getTime(), 'capturado_em é sempre o instante real do servidor, nunca o valor enviado')
  assert.ok(Date.now() - new Date(data.capturado_em).getTime() < 5000, 'capturado_em reflete "agora", não a data forjada de mais de 1 dia atrás')
})

test('horario_declarado é opcional, distinto de capturado_em/decidido_em, e nunca vira registrado_em da marcação aprovada', async () => {
  const colaborador = await novoColaborador()
  const horaDeclarada = new Date(Date.now() - 30 * 60 * 1000).toISOString() // "cheguei 30 min atrás"
  const solicitacao = await criarSolicitacao(colaborador, { horario_declarado: horaDeclarada })
  assert.ok(solicitacao.horario_declarado, 'campo precisa vir preenchido na resposta')
  assert.equal(new Date(solicitacao.horario_declarado).toISOString(), horaDeclarada)
  assert.notEqual(solicitacao.horario_declarado, solicitacao.criado_em, 'horario_declarado e criado_em(capturado_em) são independentes')

  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(decidir.status, 200)

  const supabase = obterSupabaseDeTeste()
  const { data: marcacao } = await supabase.from('ponto_marcacoes').select('registrado_em').eq('id', decidir.body.marcacao_gerada.id).single()
  const { data: solic } = await supabase.from('ponto_solicitacoes_marcacao').select('capturado_em').eq('id', solicitacao.id).single()
  assert.equal(new Date(marcacao.registrado_em).toISOString(), new Date(solic.capturado_em).toISOString(), 'registrado_em usa capturado_em (servidor), nunca horario_declarado (auto-relatado)')
})

test('solicitação pendente de colaborador desabilitado no meio do caminho continua decidível — histórico não é apagado', async () => {
  const usuario = await novoColaborador()
  const solicitacao = await criarSolicitacao(usuario)

  // Desabilita o colaborador DEPOIS de ele já ter enviado a solicitação —
  // decisão deliberada: desabilitar impede novas solicitações (ver
  // exigirColaboradorHabilitado), mas não apaga nem invalida o que já foi
  // enviado.
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_habilitacoes').update({ habilitado: false }).eq('usuario_id', usuario.id)

  const novaSolicitacaoBloqueada = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'saida', senha_atual: usuario.senha, justificativa: 'teste' },
  })
  assert.equal(novaSolicitacaoBloqueada.status, 403, 'desabilitado não envia solicitação NOVA')

  const decidir = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacao.id}/decisao`, { token: gerarToken(gestor), body: { decisao: 'aprovada' } })
  assert.equal(decidir.status, 200, 'a solicitação enviada ANTES de desabilitar continua decidível pelo gestor — histórico preservado, não some')
  assert.ok(decidir.body.marcacao_gerada?.id)
})
