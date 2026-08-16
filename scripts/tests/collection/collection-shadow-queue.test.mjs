// 2026-08-16 — fila operacional (GET /api/collection-shadow/queue). 100%
// leitura de dados já persistidos (score/NBA/timeline) — nunca recalcula,
// nunca despacha, nunca muta tabela financeira. Contra um servidor Express
// real e o código de produção real (runCollectionShadow), nunca fabricando
// resultado de NBA à mão — as divergências (EM_REVISAO_FINANCEIRA,
// SEM_TELEFONE) precisam vir do guard de verdade, senão o teste provaria só
// a própria suposição, não o comportamento real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

test('API da fila operacional (collection-shadow-reports /queue)', async (t) => {
  await iniciarAmbienteDeTeste()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste'
  process.env.API_SECRET_KEY = process.env.API_SECRET_KEY || 'teste-secret-queue'

  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const reportsRouter = (await import('../../../src/routes/collection-shadow-reports.js')).default
  const { calcularEPersistirRecoveryScore } = await import('../../../src/lib/collection/recoveryScore.js')
  const { calcularEPersistirPriorityScore } = await import('../../../src/lib/collection/priorityScore.js')
  const { runCollectionShadow } = await import('../../../src/jobs/collection-shadow.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  const app = express()
  app.use('/api/collection-shadow', auth, adminOnly, reportsRouter)
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${process.env.API_SECRET_KEY}` }
  const contas = {}

  async function snapshotOperacional() {
    const [{ count: dispatches }, { count: envios }, { count: promessas }, { count: baixas }] = await Promise.all([
      supabase.from('collection_dispatches').select('id', { count: 'exact', head: true }),
      supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true }),
      supabase.from('collection_promises').select('id', { count: 'exact', head: true }),
      supabase.from('baixas_financeiras').select('id', { count: 'exact', head: true }).limit(1),
    ])
    return { dispatches, envios, promessas, baixas: baixas ?? 0 }
  }

  // Roda um ciclo REAL do shadow, escopado só pra conta pedida (shadow_max_customers
  // grande o bastante pra cobrir tudo que o teste já criou até aqui + a cursor
  // rotativo, então basta esperar o retorno normal).
  async function rodarShadowCompleto() {
    await supabase.from('automacoes_config').update({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 5000 }).eq('id', 1)
    invalidarCacheFlags()
    await runCollectionShadow()
    await supabase.from('automacoes_config').update({ nba_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
    invalidarCacheFlags()
  }

  async function comScore(conta) {
    const recovery = await calcularEPersistirRecoveryScore(conta.id)
    await calcularEPersistirPriorityScore(conta.id, { recoveryScore: recovery.score })
    return recovery
  }

  await t.test('setup: várias contas com perfis diferentes (normal, em revisão, sem telefone, paga)', async () => {

    contas.normal = await criarContaDeTeste(supabase, { valor: 900, vencimento: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10) })
    await comScore(contas.normal)

    contas.revisao = await criarContaDeTeste(supabase, { valor: 500, em_revisao_financeira: true, vencimento: new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10) })
    await comScore(contas.revisao)

    // criarContaDeTeste usa `overrides.telefone_cobranca || telefoneDeTeste()` —
    // passar null cai no fallback (null é falsy), então o telefone precisa ser
    // removido DEPOIS, via update direto, pra realmente simular "sem telefone".
    contas.semTelefone = await criarContaDeTeste(supabase, { valor: 300, vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })
    await supabase.from('contas_financeiras').update({ telefone_cobranca: null }).eq('id', contas.semTelefone.id)
    await comScore(contas.semTelefone)

    contas.paga = await criarContaDeTeste(supabase, { valor: 200, valor_pago: 200, status: 'paga', vencimento: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10) })
    // conta paga NÃO passa pela rotação do shadow (saldo<=0 é pulado no loop) —
    // simula resíduo real: score persistido "manualmente" ANTES do título ser
    // marcado como paga, exatamente como aconteceu em produção (homologação
    // anterior). Isso é o cenário 9 (não vazar título pago pra fila ativa).
    await supabase.from('contas_financeiras').update({ status: 'aberta' }).eq('id', contas.paga.id)
    await comScore(contas.paga)
    await supabase.from('contas_financeiras').update({ status: 'paga' }).eq('id', contas.paga.id)

    await rodarShadowCompleto()
  })

  await t.test('1. paginação: limit respeitado, total_paginas coerente', async () => {
    const r1 = await fetch(`${base}/api/collection-shadow/queue?limit=1&page=1`, { headers })
    const b1 = await r1.json()
    assert.equal(b1.data.length, 1)
    assert.equal(b1.limit, 1)
    assert.equal(b1.page, 1)
    assert.equal(b1.total_paginas, b1.total_filtrado, 'com limit=1, total_paginas deveria ser igual ao total de linhas filtradas')

    const r2 = await fetch(`${base}/api/collection-shadow/queue?limit=1&page=2`, { headers })
    const b2 = await r2.json()
    assert.notEqual(b1.data[0]?.contas_financeiras_id, b2.data[0]?.contas_financeiras_id, 'página 2 deveria trazer item diferente da página 1')
  })

  await t.test('2. ordenação: priority_desc (padrão) vem em ordem decrescente; priority_asc inverte', async () => {
    const rDesc = await fetch(`${base}/api/collection-shadow/queue?limit=200&sort=priority_desc`, { headers })
    const desc = (await rDesc.json()).data
    for (let i = 1; i < desc.length; i++) {
      assert.ok((desc[i - 1].priority_score ?? -1) >= (desc[i].priority_score ?? -1), 'priority_desc fora de ordem')
    }

    const rAsc = await fetch(`${base}/api/collection-shadow/queue?limit=200&sort=priority_asc`, { headers })
    const asc = (await rAsc.json()).data
    for (let i = 1; i < asc.length; i++) {
      assert.ok((asc[i - 1].priority_score ?? 999) <= (asc[i].priority_score ?? 999), 'priority_asc fora de ordem')
    }
  })

  await t.test('3. filtros combináveis: faixa + telefone', async () => {
    const r = await fetch(`${base}/api/collection-shadow/queue?limit=200&telefone=false`, { headers })
    const body = await r.json()
    assert.ok(body.data.length >= 1)
    for (const linha of body.data) assert.equal(linha.telefone_disponivel, false)
  })

  await t.test('4. view=revisao_humana captura HUMAN_REVIEW', async () => {
    const r = await fetch(`${base}/api/collection-shadow/queue?limit=200&view=revisao_humana`, { headers })
    const body = await r.json()
    assert.ok(body.data.length >= 1)
    for (const linha of body.data) assert.equal(linha.nba_suggested_action, 'HUMAN_REVIEW')
    const idsEsperados = new Set([contas.revisao.id, contas.semTelefone.id])
    for (const linha of body.data) {
      if (idsEsperados.has(linha.contas_financeiras_id)) idsEsperados.delete(linha.contas_financeiras_id)
    }
    assert.equal(idsEsperados.size, 0, 'revisão financeira e sem telefone deveriam ambos cair em revisao_humana')
  })

  await t.test('5. blocked=EM_REVISAO_FINANCEIRA filtra só o título em revisão', async () => {
    const r = await fetch(`${base}/api/collection-shadow/queue?limit=200&blocked=EM_REVISAO_FINANCEIRA`, { headers })
    const body = await r.json()
    const linha = body.data.find((l) => l.contas_financeiras_id === contas.revisao.id)
    assert.ok(linha, 'título em revisão deveria aparecer')
    assert.equal(linha.effective_legacy_action, 'NO_ACTION')
    assert.equal(linha.legacy_action, 'WHATSAPP', 'legacy_action pré-guard continua WHATSAPP — só effective muda')
    for (const l of body.data) assert.equal(l.blocked_reason, 'EM_REVISAO_FINANCEIRA')
  })

  await t.test('6. blocked=SEM_TELEFONE filtra só o título sem telefone', async () => {
    const r = await fetch(`${base}/api/collection-shadow/queue?limit=200&blocked=SEM_TELEFONE`, { headers })
    const body = await r.json()
    const linha = body.data.find((l) => l.contas_financeiras_id === contas.semTelefone.id)
    assert.ok(linha)
    assert.equal(linha.telefone_disponivel, false)
    assert.equal(linha.blocked_reason, 'SEM_TELEFONE')
  })

  await t.test('7. detalhe explicável (reaproveita /customers/:id — já traz effective_legacy_action/blocked_reason)', async () => {
    const r = await fetch(`${base}/api/collection-shadow/customers/${contas.revisao.id}`, { headers })
    const detalhe = await r.json()
    assert.ok(detalhe.priority.componentes, 'precisa ter os componentes pra explicabilidade')
    assert.ok(detalhe.recovery.componentes)
    assert.equal(detalhe.nba.effective_legacy_action, 'NO_ACTION')
    assert.equal(detalhe.nba.blocked_reason, 'EM_REVISAO_FINANCEIRA')
    assert.equal(detalhe.nba.acao, 'HUMAN_REVIEW')
  })

  await t.test('8. título sem NBA calculada (score isolado, sem rodar o shadow): aparece na fila com nba_suggested_action=null, sem quebrar', async () => {
    const conta = await criarContaDeTeste(supabase, { valor: 400, vencimento: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10) })
    await comScore(conta)
    const r = await fetch(`${base}/api/collection-shadow/queue?limit=500`, { headers })
    const body = await r.json()
    const linha = body.data.find((l) => l.contas_financeiras_id === conta.id)
    assert.ok(linha, 'título com score mas sem NBA ainda deveria aparecer na fila')
    assert.equal(linha.nba_suggested_action, null)
    assert.equal(linha.effective_legacy_action, null)
    assert.equal(linha.blocked_reason, null)
  })

  await t.test('9. título pago não entra na fila mesmo com score residual persistido', async () => {
    const r = await fetch(`${base}/api/collection-shadow/queue?limit=500`, { headers })
    const body = await r.json()
    const linha = body.data.find((l) => l.contas_financeiras_id === contas.paga.id)
    assert.equal(linha, undefined, 'título com status=paga nunca pode aparecer na fila ativa, mesmo com score órfão')
  })

  await t.test('10/11/12. ler a fila não cria dispatch, não envia WhatsApp, não muta tabela financeira/promessa', async () => {
    const antes = await snapshotOperacional()
    await fetch(`${base}/api/collection-shadow/queue?limit=500`, { headers })
    await fetch(`${base}/api/collection-shadow/queue?view=revisao_humana`, { headers })
    const depois = await snapshotOperacional()
    assert.deepEqual(depois, antes, 'ler a fila não pode alterar dispatches/envios/promessas/baixas')
  })

  await t.test('sem autenticação: /queue retorna 401', async () => {
    const r = await fetch(`${base}/api/collection-shadow/queue`)
    assert.equal(r.status, 401)
  })

  await new Promise((resolve) => server.close(resolve))
  await pararAmbienteDeTeste()
})
