// Varredura adversarial completa de parâmetros UUID nos três routers do
// módulo "Meu Ponto" (/api/ponto, /api/ponto-gestao, /api/ponto-admin) —
// continuação da auditoria de 2026-09-12
// (auditoria-fotos-historico-gestao-admin-20260912.test.mjs, seção 7, que
// encontrou e documentou o risco residual: UUID malformado chegando ao
// Postgres e caindo no catch genérico → 500).
//
// Corrigido por src/lib/ponto/validacao.js (isUuidValido/exigirUuidNoParam),
// aplicado a TODO :id/:usuario_id de rota e a todo campo de corpo/query que
// o handler usa num .eq()/.insert() do PostgREST, nos três routers.
//
// Cada rota aqui prova DUAS coisas, nunca confundidas:
//  1. Formato inválido (não é um UUID) → 400, sempre, ANTES de qualquer
//     consulta ao banco — a checagem não depende de quem está perguntando
//     nem do que existe, então não pode se tornar um oráculo de
//     autorização (ver comentário em validacao.js).
//  2. Formato válido mas inexistente/fora de escopo → o MESMO código que já
//     existia antes desta correção (404 para a maioria das rotas por id,
//     403 para colaborador_id em query — nada disso mudou aqui, só o caso
//     de formato inválido passou a ser tratado antes de chegar a esse
//     ponto).
//
// Nenhuma rota deve devolver o 404/403 de "não encontrado"/"fora do
// escopo" para um id malformado (isso criaria um terceiro status a menos
// que fosse sempre genérico) — e nenhuma deve devolver 500 com detalhe de
// Postgres vazado.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste,
  limparVinculosCircularesDeTeste, criarEquipamentoDeTeste,
} from './_setup.mjs'

let admin, gestor, colaboradorNoEscopo, colaboradorForaDoEscopo, outroColaborador
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)

  admin = await criarUsuarioDeTeste({ role: 'admin' })
  gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  colaboradorNoEscopo = await criarUsuarioDeTeste({ role: 'vendedor' })
  colaboradorForaDoEscopo = await criarUsuarioDeTeste({ role: 'vendedor' })
  outroColaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(admin.id, gestor.id, colaboradorNoEscopo.id, colaboradorForaDoEscopo.id, outroColaborador.id)

  await habilitarPontoDeTeste(colaboradorNoEscopo.id, true)
  await habilitarPontoDeTeste(colaboradorForaDoEscopo.id, true)
  await habilitarPontoDeTeste(outroColaborador.id, true)
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: colaboradorNoEscopo.id, concedidoPor: admin.id })
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_correcoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_fotos').delete().in('usuario_id', criados)
  await supabase.from('ponto_equipamento_eventos').delete().in('usuario_id', criados)
  await supabase.from('ponto_equipamentos').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

// --- Fixtures diretas no banco (mesmo padrão de correcoes.test.mjs /
// auditoria-fotos-historico-gestao-admin-20260912.test.mjs) ---

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
      justificativa: 'fixture de teste (uuid malformado vs. inexistente)',
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
      justificativa_contingencia: 'fixture de teste (uuid malformado vs. inexistente)',
      origem_solicitacao_id: solicitacaoFixture.id,
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function criarSolicitacaoPendenteDeTeste(usuario, tipo = 'saida') {
  const supabase = obterSupabaseDeTeste()
  const { data, error } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      motivo: 'outro',
      justificativa: 'fixture de teste (uuid malformado vs. inexistente) — pendente',
      dia_brt: new Date().toISOString().slice(0, 10),
      status: 'pendente',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

async function criarCorrecaoPendenteDeTeste(usuario, marcacaoId) {
  const supabase = obterSupabaseDeTeste()
  const { data, error } = await supabase
    .from('ponto_correcoes')
    .insert({
      marcacao_id: marcacaoId,
      usuario_id: usuario.id,
      tipo_solicitacao: 'outro',
      valor_proposto: { nota: 'fixture' },
      justificativa: 'fixture de teste (uuid malformado vs. inexistente)',
      solicitado_por: usuario.id,
      status: 'pendente',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// IDs com formato claramente inválido — um simples, outro no formato de
// injeção de SQL (a prova real contra injeção está nas funções Postgres
// parametrizadas; aqui só se confirma que a VALIDAÇÃO DE FORMATO intercepta
// os dois igualmente, sem tratamento especial por conteúdo).
const ID_MALFORMADO_SIMPLES = 'nao-e-um-uuid'
const ID_MALFORMADO_INJECAO = "1' OR '1'='1"
const IDS_MALFORMADOS = [ID_MALFORMADO_SIMPLES, ID_MALFORMADO_INJECAO]

function corpoNaoVazaDetalheInterno(resposta) {
  const corpoTexto = JSON.stringify(resposta.body || {})
  assert.ok(!/postgres|pg_|22p02|syntax error|stack|at Object|node_modules|relation ".*" does not exist/i.test(corpoTexto),
    `vazou detalhe interno na resposta: ${corpoTexto}`)
}

// --- 1. src/routes/ponto.js (autosserviço) ---

test('GET /api/ponto/marcacoes/:id/foto — id malformado é 400; id válido de OUTRO usuário é 404 (nunca confirma existência alheia)', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('GET', `/api/ponto/marcacoes/${encodeURIComponent(idMalformado)}/foto`, { token: gerarToken(colaboradorNoEscopo) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const marcacaoDeOutro = await criarMarcacaoDeTeste(outroColaborador)
  const respostaValidaNaoDoUsuario = await chamar('GET', `/api/ponto/marcacoes/${marcacaoDeOutro}/foto`, { token: gerarToken(colaboradorNoEscopo) })
  assert.equal(respostaValidaNaoDoUsuario.status, 404, 'UUID válido de marcação de outro usuário deveria ser 404, não 400/403')
})

test('GET /api/ponto/solicitacoes/:id/foto — id malformado é 400; id válido de OUTRO usuário é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('GET', `/api/ponto/solicitacoes/${encodeURIComponent(idMalformado)}/foto`, { token: gerarToken(colaboradorNoEscopo) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const solicitacaoDeOutro = await criarSolicitacaoPendenteDeTeste(outroColaborador)
  const respostaValidaNaoDoUsuario = await chamar('GET', `/api/ponto/solicitacoes/${solicitacaoDeOutro}/foto`, { token: gerarToken(colaboradorNoEscopo) })
  assert.equal(respostaValidaNaoDoUsuario.status, 404, 'UUID válido de solicitação de outro usuário deveria ser 404, não 400/403')
})

test('GET /api/ponto/solicitacoes/por-operacao/:operacao_id — id malformado é 400 (já validado antes desta correção); id válido de OUTRO usuário é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('GET', `/api/ponto/solicitacoes/por-operacao/${encodeURIComponent(idMalformado)}`, { token: gerarToken(colaboradorNoEscopo) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
  }

  const operacaoIdValido = crypto.randomUUID()
  const respostaInexistente = await chamar('GET', `/api/ponto/solicitacoes/por-operacao/${operacaoIdValido}`, { token: gerarToken(colaboradorNoEscopo) })
  assert.equal(respostaInexistente.status, 404, 'operacao_id válido mas inexistente deveria ser 404')
})

test('POST /api/ponto/correcoes — marcacao_id malformado no corpo é 400; marcacao_id válido de OUTRO usuário é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('POST', '/api/ponto/correcoes', {
      token: gerarToken(colaboradorNoEscopo),
      body: { marcacao_id: idMalformado, tipo_solicitacao: 'outro', valor_proposto: { nota: 'x' }, justificativa: 'teste' },
    })
    assert.equal(resposta.status, 400, `marcacao_id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const marcacaoDeOutro = await criarMarcacaoDeTeste(outroColaborador)
  const respostaValidaNaoDoUsuario = await chamar('POST', '/api/ponto/correcoes', {
    token: gerarToken(colaboradorNoEscopo),
    body: { marcacao_id: marcacaoDeOutro, tipo_solicitacao: 'outro', valor_proposto: { nota: 'x' }, justificativa: 'teste' },
  })
  assert.equal(respostaValidaNaoDoUsuario.status, 404, 'marcacao_id válido de outro usuário deveria ser 404, não 400/403')
})

// --- 2. src/routes/ponto-gestao.js ---

test('GET /api/ponto-gestao/marcacoes/:id/foto — id malformado é 400; id válido fora do escopo é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('GET', `/api/ponto-gestao/marcacoes/${encodeURIComponent(idMalformado)}/foto`, { token: gerarToken(gestor) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const marcacaoForaDoEscopo = await criarMarcacaoDeTeste(colaboradorForaDoEscopo)
  const respostaForaDoEscopo = await chamar('GET', `/api/ponto-gestao/marcacoes/${marcacaoForaDoEscopo}/foto`, { token: gerarToken(gestor) })
  assert.equal(respostaForaDoEscopo.status, 404, 'UUID válido fora do escopo do gestor deveria ser 404, não 400')
})

test('GET /api/ponto-gestao/solicitacoes/:id/foto — id malformado é 400; id válido fora do escopo é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('GET', `/api/ponto-gestao/solicitacoes/${encodeURIComponent(idMalformado)}/foto`, { token: gerarToken(gestor) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const solicitacaoForaDoEscopo = await criarSolicitacaoPendenteDeTeste(colaboradorForaDoEscopo)
  const respostaForaDoEscopo = await chamar('GET', `/api/ponto-gestao/solicitacoes/${solicitacaoForaDoEscopo}/foto`, { token: gerarToken(gestor) })
  assert.equal(respostaForaDoEscopo.status, 404, 'UUID válido fora do escopo do gestor deveria ser 404, não 400')
})

test('POST /api/ponto-gestao/correcoes/:id/decisao — id malformado é 400; id válido fora do escopo é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('POST', `/api/ponto-gestao/correcoes/${encodeURIComponent(idMalformado)}/decisao`, {
      token: gerarToken(gestor),
      body: { decisao: 'aprovada' },
    })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const marcacaoForaDoEscopo = await criarMarcacaoDeTeste(colaboradorForaDoEscopo)
  const correcaoForaDoEscopo = await criarCorrecaoPendenteDeTeste(colaboradorForaDoEscopo, marcacaoForaDoEscopo)
  const respostaForaDoEscopo = await chamar('POST', `/api/ponto-gestao/correcoes/${correcaoForaDoEscopo}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'aprovada' },
  })
  assert.equal(respostaForaDoEscopo.status, 404, 'UUID válido fora do escopo do gestor deveria ser 404, não 400')
})

test('POST /api/ponto-gestao/solicitacoes/:id/decisao — id malformado é 400; id válido fora do escopo é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('POST', `/api/ponto-gestao/solicitacoes/${encodeURIComponent(idMalformado)}/decisao`, {
      token: gerarToken(gestor),
      body: { decisao: 'aprovada' },
    })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const solicitacaoForaDoEscopo = await criarSolicitacaoPendenteDeTeste(colaboradorForaDoEscopo)
  const respostaForaDoEscopo = await chamar('POST', `/api/ponto-gestao/solicitacoes/${solicitacaoForaDoEscopo}/decisao`, {
    token: gerarToken(gestor),
    body: { decisao: 'aprovada' },
  })
  assert.equal(respostaForaDoEscopo.status, 404, 'UUID válido fora do escopo do gestor deveria ser 404, não 400')
})

for (const rota of ['marcacoes', 'correcoes', 'solicitacoes']) {
  test(`GET /api/ponto-gestao/${rota}?colaborador_id= — malformado é 400 (nunca 403), válido fora do escopo continua 403`, async () => {
    for (const idMalformado of IDS_MALFORMADOS) {
      const resposta = await chamar('GET', `/api/ponto-gestao/${rota}?colaborador_id=${encodeURIComponent(idMalformado)}`, { token: gerarToken(gestor) })
      assert.equal(resposta.status, 400, `colaborador_id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
      corpoNaoVazaDetalheInterno(resposta)
    }

    const respostaForaDoEscopo = await chamar('GET', `/api/ponto-gestao/${rota}?colaborador_id=${colaboradorForaDoEscopo.id}`, { token: gerarToken(gestor) })
    assert.equal(respostaForaDoEscopo.status, 403, 'colaborador_id de formato válido mas fora do escopo deveria continuar 403 (comportamento preexistente, não alterado)')
  })
}

// Prova de "sem oráculo de autorização" (ver asserções de cada rota acima):
// para o MESMO gestor e a MESMA rota, formato inválido é SEMPRE 400 e nunca
// 403 — a checagem de formato roda antes da checagem de escopo
// (colaboradorNoEscopo), então o 400 nunca varia com o que esse gestor pode
// ou não ver. Um gestor sem NENHUM vínculo em ponto_gestores nem chega a
// essa checagem: é bloqueado antes, pelo gate exigirGestorOuAdmin no mount
// do router (403 sempre, independente do conteúdo da query string) — gate
// preexistente, não alterado por esta correção.

// --- 3. src/routes/ponto-admin.js ---

test('PATCH /api/ponto-admin/habilitacoes/:usuario_id — id malformado é 400; id válido inexistente é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('PATCH', `/api/ponto-admin/habilitacoes/${encodeURIComponent(idMalformado)}`, {
      token: gerarToken(admin),
      body: { habilitado: true },
    })
    assert.equal(resposta.status, 400, `usuario_id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const respostaInexistente = await chamar('PATCH', `/api/ponto-admin/habilitacoes/${crypto.randomUUID()}`, {
    token: gerarToken(admin),
    body: { habilitado: true },
  })
  assert.equal(respostaInexistente.status, 404, 'usuario_id válido mas inexistente deveria ser 404')
})

test('DELETE /api/ponto-admin/gestores/:id — id malformado é 400; id válido inexistente é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('DELETE', `/api/ponto-admin/gestores/${encodeURIComponent(idMalformado)}`, { token: gerarToken(admin) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const respostaInexistente = await chamar('DELETE', `/api/ponto-admin/gestores/${crypto.randomUUID()}`, { token: gerarToken(admin) })
  assert.equal(respostaInexistente.status, 404, 'id válido mas inexistente deveria ser 404')
})

test('POST /api/ponto-admin/gestores — gestor_usuario_id/colaborador_usuario_id malformados no corpo são 400', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const respostaGestor = await chamar('POST', '/api/ponto-admin/gestores', {
      token: gerarToken(admin),
      body: { gestor_usuario_id: idMalformado, colaborador_usuario_id: outroColaborador.id },
    })
    assert.equal(respostaGestor.status, 400, `gestor_usuario_id "${idMalformado}" deveria ser 400, veio ${respostaGestor.status}`)
    corpoNaoVazaDetalheInterno(respostaGestor)

    const respostaColaborador = await chamar('POST', '/api/ponto-admin/gestores', {
      token: gerarToken(admin),
      body: { gestor_usuario_id: outroColaborador.id, colaborador_usuario_id: idMalformado },
    })
    assert.equal(respostaColaborador.status, 400, `colaborador_usuario_id "${idMalformado}" deveria ser 400, veio ${respostaColaborador.status}`)
    corpoNaoVazaDetalheInterno(respostaColaborador)
  }
})

test('POST /api/ponto-admin/equipamentos — usuario_id malformado no corpo é 400', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('POST', '/api/ponto-admin/equipamentos', {
      token: gerarToken(admin),
      body: { usuario_id: idMalformado, identificador: 'Equipamento teste uuid malformado' },
    })
    assert.equal(resposta.status, 400, `usuario_id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }
})

test('POST /api/ponto-admin/equipamentos/:id/vinculos — id malformado é 400, mesmo com EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('POST', `/api/ponto-admin/equipamentos/${encodeURIComponent(idMalformado)}/vinculos`, { token: gerarToken(admin) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400 (validação de formato roda antes do gate de feature), veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }
})

test('DELETE /api/ponto-admin/equipamentos/:id — id malformado é 400; id válido inexistente é 404', async () => {
  for (const idMalformado of IDS_MALFORMADOS) {
    const resposta = await chamar('DELETE', `/api/ponto-admin/equipamentos/${encodeURIComponent(idMalformado)}`, { token: gerarToken(admin) })
    assert.equal(resposta.status, 400, `id "${idMalformado}" deveria ser 400, veio ${resposta.status}`)
    corpoNaoVazaDetalheInterno(resposta)
  }

  const respostaInexistente = await chamar('DELETE', `/api/ponto-admin/equipamentos/${crypto.randomUUID()}`, { token: gerarToken(admin) })
  assert.equal(respostaInexistente.status, 404, 'id válido mas inexistente deveria ser 404')
})

// --- 4. Controle positivo — um equipamento REAL ainda pode ser revogado
// normalmente depois da validação de formato (a correção não bloqueia o
// caminho legítimo) ---

test('controle positivo: DELETE /api/ponto-admin/equipamentos/:id com UUID real e válido continua revogando normalmente', async () => {
  const equipamentoId = await criarEquipamentoDeTeste({ usuarioId: colaboradorNoEscopo.id, cadastradoPor: admin.id })
  const resposta = await chamar('DELETE', `/api/ponto-admin/equipamentos/${equipamentoId}`, { token: gerarToken(admin) })
  assert.equal(resposta.status, 200)
  assert.equal(resposta.body.revogado, true)
})
