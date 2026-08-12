// FASE B.2 (homologação, 2026-08-11) — testes da API de leitura usada pela
// visualização do ERP (Aging Report + Cobranças → Inteligência/Próximas
// Ações). Prova, contra um servidor Express real (não análise de código):
// summary/customers/customers/:id/next-actions retornam dados corretos, sem
// recalcular score, sem executar NBA, sem tocar Evolution, sem mutar tabela
// financeira alguma.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

test('API de relatórios do shadow (collection-shadow-reports)', async (t) => {
  await iniciarAmbienteDeTeste()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste'
  process.env.API_SECRET_KEY = process.env.API_SECRET_KEY || 'teste-secret-reports'

  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const reportsRouter = (await import('../../../src/routes/collection-shadow-reports.js')).default
  const { calcularEPersistirRecoveryScore } = await import('../../../src/lib/collection/recoveryScore.js')
  const { calcularEPersistirPriorityScore } = await import('../../../src/lib/collection/priorityScore.js')
  const { runCollectionShadow } = await import('../../../src/jobs/collection-shadow.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  const app = express()
  app.use('/api/collection-shadow', auth, adminOnly, reportsRouter)
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${process.env.API_SECRET_KEY}` }

  async function snapshotOperacional() {
    const [{ count: cf }, { count: cw }, { count: cp }] = await Promise.all([
      supabase.from('contas_financeiras').select('id', { count: 'exact', head: true }),
      supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true }),
      supabase.from('collection_promises').select('id', { count: 'exact', head: true }),
    ])
    return { contas_financeiras: cf, cobrancas_whatsapp: cw, collection_promises: cp }
  }

  await t.test('sem nenhum score persistido: /summary retorna zerado, /customers e /next-actions retornam vazio (estado inicial elegante)', async () => {
    // Achado real (homologação 2026-08-12): /summary conta GLOBALMENTE essas 3
    // tabelas, sem escopo por teste — rodar depois de qualquer outro teste que
    // já tenha persistido score/NBA (mesmo em outro arquivo, contra o mesmo
    // Postgres local) quebra a asserção de "estado vazio". Limpa antes de
    // afirmar zero, em vez de depender de a suíte inteira nunca ter tocado
    // essas tabelas antes.
    await supabase.from('collection_recovery_scores').delete().neq('contas_financeiras_id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('collection_priority_scores').delete().neq('contas_financeiras_id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('nba_shadow_log').delete().neq('contas_financeiras_id', '00000000-0000-0000-0000-000000000000')

    const rSummary = await fetch(`${base}/api/collection-shadow/summary`, { headers })
    const summary = await rSummary.json()
    assert.equal(summary.clientes_analisados, 0)
    assert.equal(summary.recovery.media, null)
    assert.equal(summary.nba_total, 0)

    const rCustomers = await fetch(`${base}/api/collection-shadow/customers`, { headers })
    const customers = await rCustomers.json()
    assert.deepEqual(customers.data, [])

    const rNext = await fetch(`${base}/api/collection-shadow/next-actions`, { headers })
    const next = await rNext.json()
    assert.deepEqual(next.data, [])
  })

  await t.test('com score persistido: /customers retorna o título com score correto e nba_suggested_action=null (ainda sem NBA)', async () => {
    const conta = await criarContaDeTeste(supabase, { valor: 800 })
    const recovery = await calcularEPersistirRecoveryScore(conta.id)
    const priority = await calcularEPersistirPriorityScore(conta.id, { recoveryScore: recovery.score })

    const antes = await snapshotOperacional()

    const r = await fetch(`${base}/api/collection-shadow/customers`, { headers })
    const body = await r.json()
    const linha = body.data.find((l) => l.contas_financeiras_id === conta.id)
    assert.ok(linha, 'a conta com score deveria aparecer em /customers')
    assert.equal(linha.recovery_score, recovery.score)
    assert.equal(linha.priority_score, priority.score)
    assert.equal(linha.nba_suggested_action, null, 'sem NBA calculada ainda, deve ser null — nunca inventar')
    assert.equal(linha.pessoa_nome, conta.pessoa_nome)

    const depois = await snapshotOperacional()
    assert.deepEqual(depois, antes, 'ler /customers não pode alterar NENHUMA tabela')

    const { data: scoresDepois } = await supabase.from('collection_recovery_scores').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(scoresDepois.length, 1, 'GET /customers não pode ter recalculado o score (continua só 1 linha)')
  })

  await t.test('/customers/:id retorna detalhe completo com componentes e explicação', async () => {
    const conta = await criarContaDeTeste(supabase, {})
    const recovery = await calcularEPersistirRecoveryScore(conta.id)
    await calcularEPersistirPriorityScore(conta.id, { recoveryScore: recovery.score })

    const r = await fetch(`${base}/api/collection-shadow/customers/${conta.id}`, { headers })
    const detalhe = await r.json()
    assert.equal(detalhe.contas_financeiras_id, conta.id)
    assert.equal(detalhe.recovery.score, recovery.score)
    assert.ok(detalhe.recovery.componentes, 'deveria incluir os componentes do score para a explicação')
    assert.equal(detalhe.nba, null, 'sem NBA calculada, deve ser null')
  })

  await t.test('com NBA persistida (via runCollectionShadow real, reusando score): /next-actions e /customers refletem a decisão, sem recalcular nada', async () => {
    const conta = await criarContaDeTeste(supabase, {})
    const recovery = await calcularEPersistirRecoveryScore(conta.id)
    await calcularEPersistirPriorityScore(conta.id, { recoveryScore: recovery.score })

    await supabase.from('automacoes_config').update({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 1000 }).eq('id', 1)
    invalidarCacheFlags()
    await runCollectionShadow()
    await supabase.from('automacoes_config').update({ nba_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
    invalidarCacheFlags()

    const antes = await snapshotOperacional()

    const rNext = await fetch(`${base}/api/collection-shadow/next-actions`, { headers })
    const next = await rNext.json()
    const linha = next.data.find((l) => l.contas_financeiras_id === conta.id)
    assert.ok(linha, 'deveria aparecer em /next-actions')
    assert.ok(linha.nba_suggested_action, 'deveria ter uma ação sugerida')

    const rCustomers = await fetch(`${base}/api/collection-shadow/customers`, { headers })
    const customers = await rCustomers.json()
    const linhaCustomers = customers.data.find((l) => l.contas_financeiras_id === conta.id)
    assert.equal(linhaCustomers.nba_suggested_action, linha.nba_suggested_action)

    const depois = await snapshotOperacional()
    assert.deepEqual(depois, antes, 'ler /next-actions e /customers não pode alterar nenhuma tabela financeira/operacional')
  })

  await t.test('sem autenticação: todas as rotas retornam 401, nunca vazam dado', async () => {
    for (const caminho of ['/summary', '/customers', '/next-actions']) {
      const r = await fetch(`${base}/api/collection-shadow${caminho}`)
      assert.equal(r.status, 401, `${caminho} deveria exigir autenticação`)
    }
  })

  await new Promise((resolve) => server.close(resolve))
  await pararAmbienteDeTeste()
})
