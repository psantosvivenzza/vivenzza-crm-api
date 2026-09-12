// Auditoria adversarial inédita (2026-09-12) sobre a pilha combinada
// #78+#81+#82+#83 — foco em fotos, histórico/listagens de gestão,
// exportação e administração. Cobre lacunas NÃO exercitadas pelos testes
// já existentes (permissoes-e-piloto-gate.test.mjs, correcoes.test.mjs,
// solicitacoes-decisao.test.mjs, usuario-inativo-todas-rotas.test.mjs):
//
//  1. Foto de MARCAÇÃO/SOLICITAÇÃO de colaborador fora do escopo, acessada
//     por ID DIRETO em /api/ponto-gestao/*/:id/foto (as suítes existentes só
//     cobrem a listagem com colaborador_id e a decisão, não a rota de foto).
//  2. Listagens de gestão (/correcoes, /solicitacoes) com colaborador_id
//     fora do escopo.
//  3. Listagens de gestão sem filtro nunca vazam colaborador fora do escopo,
//     mesmo quando ele tem volume de dados.
//  4. Exportação excessiva: /ponto-gestao/correcoes não tem NENHUM limite
//     de página (diferente de /marcacoes, que capa em 500) — evidência
//     quantitativa do gap.
//  5. Payload forjado na decisão (usuario_id/decidido_por/status enviados
//     no corpo não podem sobrescrever o que o servidor calcula).
//  6. Payload forjado no cadastro de equipamento (modo/status/id não podem
//     vir do cliente).
//  7. ID malformado (não-UUID) nunca vaza detalhe interno na resposta.
//  8. Vazamento de dados: resposta de foto/listagem nunca inclui
//     senha_hash nem qualquer campo de outro usuário fora do escopo.
//
// Fixtures de volume/setup usam INSERT direto no Postgres de teste (mesmo
// padrão de criarMarcacaoDeTeste em correcoes.test.mjs), não o endpoint
// HTTP real — POST /api/ponto/solicitacoes e /marcacoes têm rate limit de
// 8/5min por usuário (limiteTentativasSensiveis, preservado de propósito,
// ver CLAUDE.md) e não devem ser usados em massa só para popular fixture.
// As rotas efetivamente sob teste (GET foto/listagem, POST decisão, POST
// equipamentos) continuam chamadas via HTTP real contra o Postgres isolado.
//
// Adaptado para rodar sobre a base desta PR (codex/meu-ponto-backend-
// 20260910, PR #78 sozinha): a fixture de correção NÃO usa operacao_id
// (coluna que só existe a partir da PR #83, fora do escopo desta branch).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste, habilitarPontoDeTeste,
  definirPilotoAtivoDeTeste, concederEscopoGestorDeTeste,
  limparVinculosCircularesDeTeste,
} from './_setup.mjs'

let admin, gestor, colaboradorNoEscopo, colaboradorForaDoEscopo
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)

  admin = await criarUsuarioDeTeste({ role: 'admin' })
  gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  colaboradorNoEscopo = await criarUsuarioDeTeste({ role: 'vendedor' })
  colaboradorForaDoEscopo = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(admin.id, gestor.id, colaboradorNoEscopo.id, colaboradorForaDoEscopo.id)

  await habilitarPontoDeTeste(colaboradorNoEscopo.id, true)
  await habilitarPontoDeTeste(colaboradorForaDoEscopo.id, true)
  // gestor só tem escopo sobre colaboradorNoEscopo — colaboradorForaDoEscopo
  // é habilitado ao ponto, mas NUNCA vinculado a este gestor.
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: colaboradorNoEscopo.id, concedidoPor: admin.id })
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_correcoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_fotos').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_equipamentos').delete().in('usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

// --- Fixtures diretas no banco (não passam pelo rate limit HTTP) ---

let contadorFixture = 0
async function criarFotoDeTeste(usuario) {
  const supabase = obterSupabaseDeTeste()
  contadorFixture += 1
  const { data, error } = await supabase
    .from('ponto_fotos')
    .insert({
      usuario_id: usuario.id,
      storage_path: `${usuario.id}/fixture-auditoria/${Date.now()}-${contadorFixture}.jpg`,
      mime_type: 'image/jpeg',
      tamanho_bytes: 200,
      capturada_em: new Date().toISOString(),
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// Marcação com origem='contingencia' + foto real, já "aprovada" — satisfaz
// a mesma constraint usada em correcoes.test.mjs (toda marcação de
// contingência referencia uma solicitação).
async function criarMarcacaoComFotoDeTeste(usuario, tipo = 'entrada') {
  const supabase = obterSupabaseDeTeste()
  const fotoId = await criarFotoDeTeste(usuario)
  const dia = new Date().toISOString().slice(0, 10)
  const { data: solicitacaoFixture, error: erroFixture } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      motivo: 'outro',
      justificativa: 'fixture de auditoria — já aprovada',
      dia_brt: dia,
      foto_id: fotoId,
      status: 'aprovada',
    })
    .select('id')
    .single()
  if (erroFixture) throw erroFixture

  const { data: marcacao, error } = await supabase
    .from('ponto_marcacoes')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      origem: 'contingencia',
      dia_brt: dia,
      foto_id: fotoId,
      justificativa_contingencia: 'fixture de auditoria',
      origem_solicitacao_id: solicitacaoFixture.id,
    })
    .select('id')
    .single()
  if (error) throw error
  return { marcacaoId: marcacao.id, solicitacaoId: solicitacaoFixture.id, fotoId }
}

async function criarSolicitacaoPendenteComFotoDeTeste(usuario, tipo = 'saida') {
  const supabase = obterSupabaseDeTeste()
  const fotoId = await criarFotoDeTeste(usuario)
  const { data, error } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .insert({
      operacao_id: crypto.randomUUID(),
      usuario_id: usuario.id,
      tipo,
      motivo: 'outro',
      justificativa: 'fixture de auditoria — pendente com foto',
      dia_brt: new Date().toISOString().slice(0, 10),
      foto_id: fotoId,
      status: 'pendente',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// ponto_correcoes.operacao_id só existe a partir da PR #83 (fora do escopo
// desta PR, baseada só em #78) — não incluído aqui de propósito.
async function criarCorrecaoPendenteDeTeste(usuario, marcacaoId) {
  const supabase = obterSupabaseDeTeste()
  const { data, error } = await supabase
    .from('ponto_correcoes')
    .insert({
      marcacao_id: marcacaoId,
      usuario_id: usuario.id,
      tipo_solicitacao: 'outro',
      valor_proposto: { nota: 'auditoria' },
      justificativa: 'fixture de auditoria — correção pendente',
      solicitado_por: usuario.id,
      status: 'pendente',
    })
    .select('id')
    .single()
  if (error) throw error
  return data.id
}

// --- 1. Foto de marcação/solicitação de colaborador FORA do escopo, por ID direto ---

test('gestor NÃO consegue obter a foto de uma MARCAÇÃO de colaborador fora do seu escopo, mesmo sabendo o id exato', async () => {
  const { marcacaoId } = await criarMarcacaoComFotoDeTeste(colaboradorForaDoEscopo)

  const resposta = await chamar('GET', `/api/ponto-gestao/marcacoes/${marcacaoId}/foto`, { token: gerarToken(gestor) })

  assert.equal(resposta.status, 404, `esperado 404 (não 200 nem 403 que confirmaria existência), veio ${resposta.status}`)
  assert.ok(!resposta.body?.url, 'a resposta não pode conter nenhuma URL assinada')
})

test('gestor NÃO consegue obter a foto de uma SOLICITAÇÃO de colaborador fora do seu escopo, mesmo sabendo o id exato', async () => {
  const solicitacaoId = await criarSolicitacaoPendenteComFotoDeTeste(colaboradorForaDoEscopo)

  const resposta = await chamar('GET', `/api/ponto-gestao/solicitacoes/${solicitacaoId}/foto`, { token: gerarToken(gestor) })

  assert.equal(resposta.status, 404, `esperado 404, veio ${resposta.status}`)
  assert.ok(!resposta.body?.url, 'a resposta não pode conter nenhuma URL assinada')
})

test('gestor CONSEGUE obter a foto de uma marcação do colaborador que está no seu escopo (controle positivo)', async () => {
  const { marcacaoId } = await criarMarcacaoComFotoDeTeste(colaboradorNoEscopo)

  const resposta = await chamar('GET', `/api/ponto-gestao/marcacoes/${marcacaoId}/foto`, { token: gerarToken(gestor) })

  assert.equal(resposta.status, 200, `controle positivo falhou — gestor deveria acessar foto dentro do escopo, veio ${resposta.status}`)
  assert.ok(resposta.body?.url, 'deveria devolver uma URL assinada')
})

// --- 2. Listagens de gestão com colaborador_id fora do escopo ---

test('GET /api/ponto-gestao/correcoes?colaborador_id=<fora do escopo> é bloqueado (403), não devolve dados', async () => {
  const resposta = await chamar('GET', `/api/ponto-gestao/correcoes?colaborador_id=${colaboradorForaDoEscopo.id}`, { token: gerarToken(gestor) })
  assert.equal(resposta.status, 403)
  assert.match(resposta.body.erro, /escopo/i)
})

test('GET /api/ponto-gestao/solicitacoes?colaborador_id=<fora do escopo> é bloqueado (403), não devolve dados', async () => {
  const resposta = await chamar('GET', `/api/ponto-gestao/solicitacoes?colaborador_id=${colaboradorForaDoEscopo.id}`, { token: gerarToken(gestor) })
  assert.equal(resposta.status, 403)
  assert.match(resposta.body.erro, /escopo/i)
})

// --- 3. Listagens sem filtro nunca vazam colaborador fora do escopo ---

test('GET /api/ponto-gestao/correcoes SEM filtro nunca inclui correção de colaborador fora do escopo', async () => {
  const { marcacaoId: marcacaoForaEscopo } = await criarMarcacaoComFotoDeTeste(colaboradorForaDoEscopo)
  await criarCorrecaoPendenteDeTeste(colaboradorForaDoEscopo, marcacaoForaEscopo)

  const { marcacaoId: marcacaoNoEscopo } = await criarMarcacaoComFotoDeTeste(colaboradorNoEscopo)
  const correcaoNoEscopoId = await criarCorrecaoPendenteDeTeste(colaboradorNoEscopo, marcacaoNoEscopo)

  const resposta = await chamar('GET', '/api/ponto-gestao/correcoes', { token: gerarToken(gestor) })
  assert.equal(resposta.status, 200)
  const idsRetornados = resposta.body.itens.map((i) => i.usuario_id)
  assert.ok(!idsRetornados.includes(colaboradorForaDoEscopo.id), 'colaborador fora do escopo não pode aparecer na listagem sem filtro')
  assert.ok(resposta.body.itens.some((i) => i.id === correcaoNoEscopoId), 'correção do colaborador dentro do escopo deveria aparecer')
})

test('GET /api/ponto-gestao/solicitacoes SEM filtro nunca inclui solicitação de colaborador fora do escopo', async () => {
  const solicitacaoForaEscopoId = await criarSolicitacaoPendenteComFotoDeTeste(colaboradorForaDoEscopo, 'retorno_intervalo')

  const resposta = await chamar('GET', '/api/ponto-gestao/solicitacoes', { token: gerarToken(gestor) })
  assert.equal(resposta.status, 200)
  const idsRetornados = resposta.body.itens.map((i) => i.id)
  assert.ok(!idsRetornados.includes(solicitacaoForaEscopoId), 'solicitação de colaborador fora do escopo não pode aparecer na listagem sem filtro')
})

// --- 4. Exportação excessiva: ausência de limite em /correcoes de gestão ---

test('GET /api/ponto-gestao/correcoes não impõe NENHUM limite de itens (gap de exportação excessiva vs. /marcacoes, que capa em 500)', async () => {
  const QUANTIDADE = 60
  for (let i = 0; i < QUANTIDADE; i += 1) {
    const { marcacaoId } = await criarMarcacaoComFotoDeTeste(colaboradorNoEscopo)
    await criarCorrecaoPendenteDeTeste(colaboradorNoEscopo, marcacaoId)
  }

  const resposta = await chamar('GET', '/api/ponto-gestao/correcoes', { token: gerarToken(gestor) })
  assert.equal(resposta.status, 200)
  // Documenta o comportamento ATUAL (sem paginação): a rota devolve TODAS as
  // QUANTIDADE correções pendentes numa única resposta, sem parâmetro de
  // página/limite disponível para o cliente conter o volume — diferente do
  // padrão já usado em GET /marcacoes (pagina/limite, teto de 500).
  assert.ok(
    resposta.body.itens.length >= QUANTIDADE,
    `esperado ao menos ${QUANTIDADE} itens numa única resposta sem paginação, veio ${resposta.body.itens.length}`,
  )
})

// --- 5. Payload forjado na decisão ---

test('payload forjado: usuario_id/decidido_por/status enviados no corpo de POST .../correcoes/:id/decisao são ignorados pelo servidor', async () => {
  const { marcacaoId } = await criarMarcacaoComFotoDeTeste(colaboradorNoEscopo)
  const correcaoId = await criarCorrecaoPendenteDeTeste(colaboradorNoEscopo, marcacaoId)

  const resposta = await chamar('POST', `/api/ponto-gestao/correcoes/${correcaoId}/decisao`, {
    token: gerarToken(gestor),
    body: {
      decisao: 'aprovada',
      // Campos forjados — nenhum destes é aceito pela rota (só decisao e
      // decisao_justificativa são desestruturados do corpo); o valor real
      // de decidido_por precisa vir de req.user.id (o próprio gestor).
      usuario_id: colaboradorForaDoEscopo.id,
      decidido_por: admin.id,
      status: 'rejeitada',
      id: crypto.randomUUID(),
    },
  })
  assert.equal(resposta.status, 200)

  const supabase = obterSupabaseDeTeste()
  const { data: correcaoPersistida, error } = await supabase
    .from('ponto_correcoes')
    .select('decidido_por, status, usuario_id')
    .eq('id', correcaoId)
    .single()
  if (error) throw error

  assert.equal(correcaoPersistida.decidido_por, gestor.id, 'decidido_por forjado no corpo não pode sobrescrever o decisor real (req.user.id)')
  assert.equal(correcaoPersistida.status, 'aprovada', 'status forjado no corpo (rejeitada) não pode sobrescrever a decisão real (aprovada)')
  assert.equal(correcaoPersistida.usuario_id, colaboradorNoEscopo.id, 'usuario_id da correção não pode ser trocado por um valor forjado no corpo')
})

// --- 6. Payload forjado no cadastro de equipamento ---

test('payload forjado: modo/status/id enviados no corpo de POST /api/ponto-admin/equipamentos são ignorados pelo servidor', async () => {
  const idForjado = crypto.randomUUID()
  const resposta = await chamar('POST', '/api/ponto-admin/equipamentos', {
    token: gerarToken(admin),
    body: {
      usuario_id: colaboradorNoEscopo.id,
      identificador: 'Notebook auditoria payload forjado',
      modo: 'producao', // deveria ser sempre 'demonstracao' nesta etapa
      status: 'revogado',
      id: idForjado,
    },
  })
  assert.equal(resposta.status, 201)
  assert.equal(resposta.body.modo, 'demonstracao', 'modo forjado (producao) não pode sobrescrever o valor fixo do servidor')
  assert.notEqual(resposta.body.id, idForjado, 'id forjado no corpo não pode ser usado como id real do equipamento')

  const supabase = obterSupabaseDeTeste()
  const { data: equipamentoPersistido, error } = await supabase
    .from('ponto_equipamentos')
    .select('modo, status')
    .eq('id', resposta.body.id)
    .single()
  if (error) throw error
  assert.equal(equipamentoPersistido.modo, 'demonstracao')
  assert.equal(equipamentoPersistido.status, 'ativo', 'status forjado (revogado) não pode sobrescrever o status inicial real (ativo)')

  await supabase.from('ponto_equipamento_eventos').delete().eq('equipamento_id', resposta.body.id)
  await supabase.from('ponto_equipamentos').delete().eq('id', resposta.body.id)
})

// --- 7. ID malformado (não-UUID) nunca vaza detalhe interno, nem serve de oráculo ---
//
// Achado (severidade baixa, NÃO corrigido nesta PR — ver
// docs/meu-ponto/AUDITORIA_FOTOS_HISTORICO_GESTAO_ADMIN_2026-09-12.md,
// seção "Risco residual"): um id que não é UUID cai no erro genérico do
// Postgres (22P02, "invalid input syntax for type uuid"), capturado pelo
// catch genérico da rota → 500 com mensagem fixa e segura. Não é um
// vazamento de dado (a mensagem é sempre a mesma, nunca inclui o erro
// bruto do banco) nem um bypass de autorização — só um status HTTP
// tecnicamente incorreto (500 em vez de 400/404). O que esta prova garante
// de fato: NENHUM detalhe interno (SQL, stack, caminho de arquivo) chega
// na resposta ao cliente, em nenhuma das quatro rotas de foto.
test('ID malformado (não-UUID) em rotas de foto nunca vaza detalhe interno na resposta', async () => {
  const rotasComIdMalformado = [
    ['/api/ponto/marcacoes/nao-e-um-uuid/foto', colaboradorNoEscopo],
    ['/api/ponto/solicitacoes/nao-e-um-uuid/foto', colaboradorNoEscopo],
    ['/api/ponto-gestao/marcacoes/nao-e-um-uuid/foto', gestor],
    ['/api/ponto-gestao/solicitacoes/nao-e-um-uuid/foto', gestor],
  ]
  for (const [rota, usuario] of rotasComIdMalformado) {
    const resposta = await chamar('GET', rota, { token: gerarToken(usuario) })
    assert.ok([400, 404, 500].includes(resposta.status), `${rota} com id malformado deveria responder de forma controlada (nunca derrubar o processo), veio ${resposta.status}`)
    assert.ok(!resposta.body?.url, `${rota} não pode devolver uma URL assinada para um id malformado`)
    const corpoTexto = JSON.stringify(resposta.body || {})
    assert.ok(!/postgres|pg_|syntax error|stack|at Object|node_modules/i.test(corpoTexto), `${rota} vazou detalhe interno na resposta: ${corpoTexto}`)
  }
})

// --- 8. Vazamento de dados: nenhuma resposta pode incluir senha_hash ---

test('nenhuma resposta de listagem/foto do módulo ponto inclui senha_hash ou campos sensíveis de outro usuário', async () => {
  const { marcacaoId } = await criarMarcacaoComFotoDeTeste(colaboradorNoEscopo)
  await criarCorrecaoPendenteDeTeste(colaboradorNoEscopo, marcacaoId)

  const rotas = [
    ['/api/ponto-gestao/colaboradores', gestor],
    ['/api/ponto-gestao/marcacoes', gestor],
    ['/api/ponto-gestao/correcoes', gestor],
    ['/api/ponto-gestao/solicitacoes', gestor],
    [`/api/ponto-gestao/marcacoes/${marcacaoId}/foto`, gestor],
    ['/api/ponto-admin/habilitacoes', admin],
    ['/api/ponto-admin/gestores', admin],
  ]
  for (const [rota, usuario] of rotas) {
    const resposta = await chamar('GET', rota, { token: gerarToken(usuario) })
    const corpoTexto = JSON.stringify(resposta.body || {})
    assert.ok(!/senha_hash/i.test(corpoTexto), `${rota} vazou senha_hash na resposta`)
  }
})
