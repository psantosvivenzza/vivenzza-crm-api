// Cobre o achado da revisão de 2026-09-11 (terceira rodada): "uma
// transação resolve atomicidade, não autorização". Prova, com uma conexão
// Postgres autenticada como um papel RESTRITO (não o superusuário postgres
// que o resto dos testes usa via pgCompatClient — superusuário ignora todo
// GRANT/REVOKE, então testar só com ele nunca provaria nada aqui), que:
// - PUBLIC não executa ponto_decidir_solicitacao/ponto_decidir_correcao
//   direto (REVOKE real, migration 051).
// - Um papel com GRANT explícito CONSEGUE executar (o mecanismo de grant
//   funciona, não é só ausência de teste).
// - Mesmo chamando a função DIRETO (contornando o Express inteiro), um
//   decisor sem escopo real ou inativo é rejeitado — autorização mora no
//   banco, não só no pré-check em JavaScript.
// - Referência órfã (solicitação/marcação inexistente) é rejeitada pelas
//   FKs restauradas — nenhum enfraquecimento de schema.
//
// O QUE NÃO FOI VERIFICADO: papéis reais do Supabase (anon/authenticated/
// service_role) e o comportamento do PostgREST ao tentar chamar
// /rpc/ponto_decidir_solicitacao com uma anon key real — isso exigiria um
// projeto Supabase de teste, fora do escopo local. Ver nota de ambiente na
// migration 051.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  criarUsuarioDeTeste, habilitarPontoDeTeste, definirPilotoAtivoDeTeste,
  concederEscopoGestorDeTeste, gerarToken, chamar,
  criarPapelPostgresDeTeste, apagarPapelPostgresDeTeste,
  concederExecucaoDeTeste, concederAcessoTabelasPontoDeTeste, executarComoPapelDeTeste,
  limparVinculosCircularesDeTeste,
} from './_setup.mjs'

const ASSINATURA_SOLICITACAO = 'public.ponto_decidir_solicitacao(uuid, uuid, text, text)'
const PAPEL_RESTRITO = 'ponto_teste_papel_restrito'
const PAPEL_AUTORIZADO = 'ponto_teste_papel_autorizado'
const SENHA_PAPEL = 'senhaTesteSoNoClusterIsolado123'

let colaborador, gestor, admin, terceiroSemEscopo
const criados = []

before(async () => {
  await subirServidorDeTeste()
  await definirPilotoAtivoDeTeste(true)

  colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  gestor = await criarUsuarioDeTeste({ role: 'vendedor' })
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  terceiroSemEscopo = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(colaborador.id, gestor.id, admin.id, terceiroSemEscopo.id)

  await habilitarPontoDeTeste(colaborador.id, true)
  await concederEscopoGestorDeTeste({ gestorId: gestor.id, colaboradorId: colaborador.id, concedidoPor: admin.id })

  await criarPapelPostgresDeTeste(PAPEL_RESTRITO, SENHA_PAPEL)
  await criarPapelPostgresDeTeste(PAPEL_AUTORIZADO, SENHA_PAPEL)
  await concederExecucaoDeTeste(PAPEL_AUTORIZADO, ASSINATURA_SOLICITACAO)
  // As funções são SECURITY INVOKER (deliberado, ver migration 051) — o
  // papel chamador precisa também de acesso direto às tabelas que a
  // função toca, não só EXECUTE na função. Isto simula o perfil real de
  // `service_role` no Supabase (já tem esse acesso amplo por padrão) —
  // PAPEL_RESTRITO de propósito NÃO recebe isso, pra provar que só
  // EXECUTE sem os grants de tabela também não bastaria.
  await concederAcessoTabelasPontoDeTeste(PAPEL_AUTORIZADO)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await limparVinculosCircularesDeTeste(criados)
  await supabase.from('ponto_marcacoes').delete().in('usuario_id', criados)
  await supabase.from('ponto_solicitacoes_marcacao').delete().in('usuario_id', criados)
  await supabase.from('ponto_gestores').delete().in('gestor_usuario_id', criados)
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await apagarPapelPostgresDeTeste(PAPEL_RESTRITO)
  await apagarPapelPostgresDeTeste(PAPEL_AUTORIZADO)
  await pararServidorDeTeste()
})

async function criarSolicitacao(usuario) {
  const { body } = await chamar('POST', '/api/ponto/solicitacoes', {
    token: gerarToken(usuario),
    body: { operacao_id: crypto.randomUUID(), tipo: 'entrada', senha_atual: usuario.senha, justificativa: 'teste' },
  })
  return body
}

test('PUBLIC não executa ponto_decidir_solicitacao direto — papel sem GRANT recebe permissão negada real (42501)', async () => {
  const solicitacao = await criarSolicitacao(colaborador)
  const { erro } = await executarComoPapelDeTeste({
    papel: PAPEL_RESTRITO,
    senha: SENHA_PAPEL,
    sql: 'SELECT * FROM ponto_decidir_solicitacao($1, $2, $3, $4)',
    params: [solicitacao.id, gestor.id, 'aprovada', null],
  })
  assert.ok(erro, 'papel sem GRANT deveria ser rejeitado pelo Postgres')
  assert.equal(erro.code, '42501', 'código real de "permission denied" do Postgres')
})

test('papel com GRANT explícito CONSEGUE executar — o mecanismo de grant funciona de verdade, não é omissão de teste', async () => {
  const solicitacao = await criarSolicitacao(colaborador)
  const { rows, erro } = await executarComoPapelDeTeste({
    papel: PAPEL_AUTORIZADO,
    senha: SENHA_PAPEL,
    sql: 'SELECT * FROM ponto_decidir_solicitacao($1, $2, $3, $4)',
    params: [solicitacao.id, gestor.id, 'aprovada', 'aprovado via papel autorizado'],
  })
  assert.equal(erro, null, `esperava sucesso, veio erro: ${JSON.stringify(erro)}`)
  assert.equal(rows[0].resultado, 'decidida_agora')
  assert.ok(rows[0].marcacao_gerada_id)
})

test('chamada DIRETA da função (contornando o Express) com decisor SEM escopo real é rejeitada pela própria função — autorização não é só do pré-check em JS', async () => {
  const solicitacao = await criarSolicitacao(colaborador)
  // terceiroSemEscopo não tem vínculo em ponto_gestores sobre colaborador —
  // chamando a função direto (como o papel autorizado faria em nome dele,
  // simulando alguém que conseguisse burlar o Express), sem passar pela
  // checagem de escopo do Express.
  const { rows, erro } = await executarComoPapelDeTeste({
    papel: PAPEL_AUTORIZADO,
    senha: SENHA_PAPEL,
    sql: 'SELECT * FROM ponto_decidir_solicitacao($1, $2, $3, $4)',
    params: [solicitacao.id, terceiroSemEscopo.id, 'aprovada', null],
  })
  assert.ok(erro, 'a função deveria rejeitar mesmo chamada direto')
  assert.match(erro.message, /fora_do_escopo/)
  assert.equal(rows, null)

  // Confirma que a solicitação continua pendente — a tentativa rejeitada
  // não teve NENHUM efeito colateral.
  const supabase = obterSupabaseDeTeste()
  const { data } = await supabase.from('ponto_solicitacoes_marcacao').select('status').eq('id', solicitacao.id).single()
  assert.equal(data.status, 'pendente')
})

test('chamada direta com decisor INATIVO é rejeitada pela própria função', async () => {
  const solicitacao = await criarSolicitacao(colaborador)
  const supabase = obterSupabaseDeTeste()
  await supabase.from('usuarios').update({ ativo: false }).eq('id', gestor.id)

  const { erro } = await executarComoPapelDeTeste({
    papel: PAPEL_AUTORIZADO,
    senha: SENHA_PAPEL,
    sql: 'SELECT * FROM ponto_decidir_solicitacao($1, $2, $3, $4)',
    params: [solicitacao.id, gestor.id, 'aprovada', null],
  })
  assert.ok(erro)
  assert.match(erro.message, /decisor_invalido_ou_inativo/)

  await supabase.from('usuarios').update({ ativo: true }).eq('id', gestor.id)
})

test('admin (sem vínculo explícito em ponto_gestores) consegue decidir via a função — escopo de admin é "sem restrição", verificado dentro da função também', async () => {
  const solicitacao = await criarSolicitacao(colaborador)
  const { rows, erro } = await executarComoPapelDeTeste({
    papel: PAPEL_AUTORIZADO,
    senha: SENHA_PAPEL,
    sql: 'SELECT * FROM ponto_decidir_solicitacao($1, $2, $3, $4)',
    params: [solicitacao.id, admin.id, 'rejeitada', null],
  })
  assert.equal(erro, null)
  assert.equal(rows[0].resultado, 'decidida_agora')
})

test('FK restaurada: origem_solicitacao_id órfão (solicitação inexistente) é rejeitado, não vira uma referência solta', async () => {
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase.from('ponto_marcacoes').insert({
    operacao_id: crypto.randomUUID(),
    usuario_id: colaborador.id,
    tipo: 'entrada',
    origem: 'contingencia',
    dia_brt: new Date().toISOString().slice(0, 10),
    justificativa_contingencia: 'teste FK órfã',
    origem_solicitacao_id: '00000000-0000-0000-0000-000000000000', // não existe
  })
  assert.ok(error, 'a FK deveria rejeitar uma solicitação inexistente')
  assert.equal(error.code, '23503', 'violação de chave estrangeira real')
})

test('FK restaurada: marcacao_gerada_id órfão (marcação inexistente) é rejeitado', async () => {
  const solicitacao = await criarSolicitacao(colaborador)
  const supabase = obterSupabaseDeTeste()
  const { error } = await supabase
    .from('ponto_solicitacoes_marcacao')
    .update({ marcacao_gerada_id: '00000000-0000-0000-0000-000000000000' }) // não existe
    .eq('id', solicitacao.id)
  assert.ok(error, 'a FK deveria rejeitar uma marcação inexistente')
  assert.equal(error.code, '23503')
})
