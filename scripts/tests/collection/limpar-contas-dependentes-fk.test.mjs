// Regressão permanente pro fix de FK (23503) na limpeza de contas cr-999%
// (commit 47006b8 / PR #73): exercita a implementação REAL usada por
// sync-financeiro-telefone-propagacao.test.mjs — limparContasCr999EDependencias
// (scripts/tests/helpers/limpar-contas-dependentes-cr999.mjs) — não uma
// cópia da lógica. Cobre: remoção de contas-alvo + as 3 dependências FK,
// preservação de conta/dependências fora do prefixo cr-999%, uma 2ª chamada
// com seleção vazia, propagação de erro real (SELECT e DELETE)
// interrompendo a sequência antes de completar, e propagação de erro na
// própria consulta de existência usada pelas asserções deste arquivo.
//
// Toda consulta de verificação/limpeza usa exigirSucessoFixture — erro
// nunca pode virar "não existe"/contagem zero silenciosos. Cada fixture
// registra sua própria limpeza (por id, via t.after) logo após ser criada
// com sucesso, então nada fica pra trás mesmo se uma asserção ou uma
// preparação seguinte falhar no meio do cenário.
//
// Sem rede real, sem Evolution: só toca contas_financeiras e as 3 tabelas
// dependentes via Postgres local.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exigirSucessoFixture } from '../helpers/fixture-result.mjs'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
const { limparContasCr999EDependencias } = await import('../helpers/limpar-contas-dependentes-cr999.mjs')

const TABELAS_DEPENDENTES = ['collection_recovery_scores', 'collection_priority_scores', 'nba_shadow_log']

async function criarConta(legacyId) {
  const { data, error } = await supabase.from('contas_financeiras').insert({
    tipo: 'receber', pessoa_nome: `Regressão FK ${legacyId}`, valor: 10, valor_pago: 0,
    vencimento: new Date().toISOString().slice(0, 10), status: 'aberta',
    telefone_cobranca: '5551900000000', legacy_id: legacyId,
  }).select().single()
  if (error) throw error
  return data
}

async function anexarDependencias(contaId) {
  for (const tabela of TABELAS_DEPENDENTES) {
    const payload = tabela === 'nba_shadow_log'
      ? { contas_financeiras_id: contaId, nba_suggested_action: 'NO_ACTION' }
      : { contas_financeiras_id: contaId, score: 1, formula_version: 'regressao-fk', componentes: {}, explicacao: 'regressao-fk' }
    const { error } = await supabase.from(tabela).insert(payload)
    if (error) throw error
  }
}

async function contarDependencias(contaId) {
  const contagens = {}
  for (const tabela of TABELAS_DEPENDENTES) {
    const { count } = await exigirSucessoFixture(`contar ${tabela} de ${contaId}`,
      supabase.from(tabela).select('id', { count: 'exact', head: true }).eq('contas_financeiras_id', contaId))
    contagens[tabela] = count
  }
  return contagens
}

async function contarDependenciasParaIds(tabela, ids) {
  const { count } = await exigirSucessoFixture(`contar ${tabela} para ${ids.length} id(s)`,
    supabase.from(tabela).select('id', { count: 'exact', head: true }).in('contas_financeiras_id', ids))
  return count
}

// Erro na consulta de existência precisa propagar — nunca pode virar
// "conta não existe" só porque a query falhou (ver cenário 4c abaixo).
async function contaExiste(id) {
  const { data } = await exigirSucessoFixture(`verificar existência da conta ${id}`,
    supabase.from('contas_financeiras').select('id').eq('id', id).maybeSingle())
  return !!data
}

async function apagarContaEDependenciasDireto(contaId) {
  for (const tabela of TABELAS_DEPENDENTES) {
    await exigirSucessoFixture(`apagar ${tabela} de ${contaId} (limpeza direta)`,
      supabase.from(tabela).delete().eq('contas_financeiras_id', contaId))
  }
  await exigirSucessoFixture(`apagar conta ${contaId} (limpeza direta)`,
    supabase.from('contas_financeiras').delete().eq('id', contaId))
}

// Mesmo padrão de sync-financeiro-erro-persistencia.test.mjs
// (interceptarInsertErros): intercepta supabase.from só pra UMA tabela/chamada
// específica, delega tudo mais pro client real — nunca mexe em produto.
function interceptarSelectContasComErro(erroDesejado) {
  const originalFrom = supabase.from
  supabase.from = (tabela) => {
    if (tabela !== 'contas_financeiras') return originalFrom(tabela)
    return { select: () => ({ like: () => Promise.resolve({ data: null, error: erroDesejado }) }) }
  }
  return { restaurar: () => { supabase.from = originalFrom } }
}

function interceptarDeleteComErro(tabelaAlvo, erroDesejado) {
  const originalFrom = supabase.from
  supabase.from = (tabela) => {
    if (tabela !== tabelaAlvo) return originalFrom(tabela)
    return { delete: () => ({ in: () => Promise.resolve({ data: null, error: erroDesejado }) }) }
  }
  return { restaurar: () => { supabase.from = originalFrom } }
}

// Intercepta especificamente a cadeia .select('id').eq('id', id).maybeSingle()
// usada por contaExiste() — cadeia diferente da usada em
// interceptarSelectContasComErro (.select('id').like(...)).
function interceptarExistsComErro(erroDesejado) {
  const originalFrom = supabase.from
  supabase.from = (tabela) => {
    if (tabela !== 'contas_financeiras') return originalFrom(tabela)
    return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: erroDesejado }) }) }) }
  }
  return { restaurar: () => { supabase.from = originalFrom } }
}

test('limparContasCr999EDependencias: remoção por FK, preservação fora do prefixo, seleção vazia e propagação de erro', async (tSuite) => {
  // Limpa qualquer resíduo cr-999% de execuções anteriores ANTES de começar,
  // usando a própria implementação real (mesma prática do resto da suíte).
  await limparContasCr999EDependencias(supabase)

  await tSuite.test('1. remove as contas-alvo e as três dependências FK (recovery/priority/nba)', async (t) => {
    const alvo1 = await criarConta('cr-999-regressaofk-alvo-001')
    t.after(() => apagarContaEDependenciasDireto(alvo1.id))
    await anexarDependencias(alvo1.id)

    const alvo2 = await criarConta('cr-999-regressaofk-alvo-002')
    t.after(() => apagarContaEDependenciasDireto(alvo2.id))
    await anexarDependencias(alvo2.id)

    const idsRemovidos = await limparContasCr999EDependencias(supabase)

    assert.equal(new Set(idsRemovidos).size, idsRemovidos.length, 'sem ids duplicados na seleção')
    assert.ok(idsRemovidos.includes(alvo1.id), 'alvo1 precisa estar entre os ids removidos')
    assert.ok(idsRemovidos.includes(alvo2.id), 'alvo2 precisa estar entre os ids removidos')
    assert.equal(await contaExiste(alvo1.id), false, 'alvo1 precisa ter sido apagada')
    assert.equal(await contaExiste(alvo2.id), false, 'alvo2 precisa ter sido apagada')

    for (const tabela of TABELAS_DEPENDENTES) {
      assert.equal(await contarDependenciasParaIds(tabela, [alvo1.id, alvo2.id]), 0, `${tabela} precisa estar zerada pros ids das contas removidas`)
    }
  })

  let controle
  await tSuite.test('2. preserva conta fora do prefixo cr-999% e suas três dependências', async (t) => {
    controle = await criarConta('cr-888-regressaofk-controle-001') // fora do prefixo cr-999%
    // Cleanup do controle registrado no tSuite (escopo do teste inteiro, não
    // deste subteste) — precisa sobreviver aos cenários 3 e 4, e só ser
    // apagado quando TODO o arquivo terminar, mesmo se algum cenário
    // seguinte falhar.
    tSuite.after(() => apagarContaEDependenciasDireto(controle.id))
    await anexarDependencias(controle.id)

    const alvo = await criarConta('cr-999-regressaofk-alvo-003')
    t.after(() => apagarContaEDependenciasDireto(alvo.id))
    await anexarDependencias(alvo.id)

    const idsRemovidos = await limparContasCr999EDependencias(supabase)

    assert.ok(idsRemovidos.includes(alvo.id), 'a conta-alvo deste cenário precisa ter sido selecionada')
    assert.equal(idsRemovidos.includes(controle.id), false, 'a conta controle NUNCA pode ser selecionada')
    assert.equal(await contaExiste(alvo.id), false, 'conta-alvo precisa ter sido removida')
    assert.equal(await contaExiste(controle.id), true, 'conta fora do prefixo cr-999% nunca pode ser removida')
    assert.deepEqual(await contarDependencias(controle.id), { collection_recovery_scores: 1, collection_priority_scores: 1, nba_shadow_log: 1 },
      'dependências da conta controle precisam continuar intactas')
  })

  await tSuite.test('3. segunda execução com seleção vazia não lança e preserva o controle', async () => {
    const idsRemovidos = await limparContasCr999EDependencias(supabase)
    assert.deepEqual(idsRemovidos, [], 'nada deveria casar com cr-999% depois dos cenários 1 e 2')
    assert.equal(await contaExiste(controle.id), true, 'controle precisa sobreviver a uma 2ª chamada com seleção vazia')
    assert.deepEqual(await contarDependencias(controle.id), { collection_recovery_scores: 1, collection_priority_scores: 1, nba_shadow_log: 1 },
      'dependências do controle precisam sobreviver a uma 2ª chamada com seleção vazia')
  })

  await tSuite.test('4a. erro no SELECT de contas_financeiras propaga e interrompe ANTES de qualquer DELETE', async (t) => {
    const alvo = await criarConta('cr-999-regressaofk-alvo-004')
    t.after(() => apagarContaEDependenciasDireto(alvo.id))
    await anexarDependencias(alvo.id)

    const erroForcado = { code: 'FORCED_SELECT_ERROR', message: 'falha forçada no SELECT (teste)' }
    const { restaurar } = interceptarSelectContasComErro(erroForcado)
    try {
      await assert.rejects(
        limparContasCr999EDependencias(supabase),
        (erro) => { assert.match(erro.message, /FORCED_SELECT_ERROR|falha forçada no SELECT/); return true },
      )
    } finally {
      // Restauração ANTES de qualquer consulta de verificação/limpeza —
      // senão as próprias asserções abaixo (e o t.after registrado acima)
      // cairiam no mock em vez do Postgres real.
      restaurar()
    }

    assert.equal(await contaExiste(alvo.id), true, 'SELECT falhou — DELETE final nunca deveria ter sido tentado')
    assert.deepEqual(await contarDependencias(alvo.id), { collection_recovery_scores: 1, collection_priority_scores: 1, nba_shadow_log: 1 },
      'nenhuma das 3 dependências deveria ter sido tocada — a sequência nunca saiu do SELECT')
  })

  await tSuite.test('4b. erro num DELETE de dependência propaga e interrompe ANTES das etapas seguintes', async (t) => {
    const alvo = await criarConta('cr-999-regressaofk-alvo-005')
    t.after(() => apagarContaEDependenciasDireto(alvo.id))
    await anexarDependencias(alvo.id)

    const erroForcado = { code: 'FORCED_DELETE_ERROR', message: 'falha forçada no DELETE de priority scores (teste)' }
    const { restaurar } = interceptarDeleteComErro('collection_priority_scores', erroForcado)
    try {
      await assert.rejects(
        limparContasCr999EDependencias(supabase),
        (erro) => { assert.match(erro.message, /FORCED_DELETE_ERROR|falha forçada no DELETE/); return true },
      )
    } finally {
      restaurar()
    }

    // Ordem real do helper: recovery_scores roda ANTES de priority_scores —
    // já foi apagado de verdade antes do erro forçado interromper a sequência.
    const contagensDepois = await contarDependencias(alvo.id)
    assert.equal(contagensDepois.collection_recovery_scores, 0, 'a dependência anterior à que falhou precisa ter sido apagada de verdade')
    assert.equal(contagensDepois.collection_priority_scores, 1, 'o DELETE que falhou nunca chegou a tocar o banco real')
    assert.equal(contagensDepois.nba_shadow_log, 1, 'a 3ª dependência nunca deveria ter sido alcançada')
    assert.equal(await contaExiste(alvo.id), true, 'contas_financeiras final nunca deveria ter sido alcançado')
  })

  await tSuite.test('4c. erro na consulta de existência (contaExiste) propaga, nunca vira "não existe"', async (t) => {
    const alvo = await criarConta('cr-999-regressaofk-alvo-006')
    t.after(() => apagarContaEDependenciasDireto(alvo.id))

    const erroForcado = { code: 'FORCED_EXISTS_ERROR', message: 'falha forçada na consulta de existência (teste)' }
    const { restaurar } = interceptarExistsComErro(erroForcado)
    try {
      await assert.rejects(
        contaExiste(alvo.id),
        (erro) => { assert.match(erro.message, /FORCED_EXISTS_ERROR|falha forçada na consulta de existência/); return true },
      )
    } finally {
      restaurar()
    }

    // Confirma contra o banco real (já restaurado) que a conta de fato
    // existe — a consulta forçada a falhar não podia ter sido interpretada
    // como "não existe" em nenhum ponto acima.
    assert.equal(await contaExiste(alvo.id), true, 'a conta criada neste cenário realmente existe — o erro forçado não podia ter mascarado isso')
  })
})
