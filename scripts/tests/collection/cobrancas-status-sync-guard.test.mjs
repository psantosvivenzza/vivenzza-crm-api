// 2026-08-16 — GET /api/cobrancas/status ganhou sync_financeiro: distingue
// "régua configurada como ativa" (cobranca_whatsapp_ativa) de "envio
// permitido agora" (financialSyncGuard). Achado real: o frontend mostrava
// "próximo disparo hoje às 08h" mesmo com o guard bloqueado — este campo
// existe pra corrigir só a comunicação visual, sem mudar nenhum
// comportamento de envio (a rota continua 100% leitura).
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, app, server, base, headers, _resetCacheParaTeste

before(async () => {
  await iniciarAmbienteDeTeste()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste'
  process.env.API_SECRET_KEY = process.env.API_SECRET_KEY || 'teste-secret-status-sync'

  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ _resetCacheParaTeste } = await import('../../../src/lib/collection/financialSyncGuard.js'))
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const cobrancasRouter = (await import('../../../src/routes/cobrancas.js')).default

  app = express()
  app.use('/api/cobrancas', auth, adminOnly, cobrancasRouter)
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  base = `http://127.0.0.1:${server.address().port}`
  headers = { authorization: `Bearer ${process.env.API_SECRET_KEY}` }
})
after(async () => { await new Promise((resolve) => server.close(resolve)); await pararAmbienteDeTeste() })

async function limparSincronizacoes() {
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
}
async function inserirSyncFresco() {
  const agora = new Date().toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: agora, concluido_em: agora,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
}
async function inserirSyncStale() {
  const velho = new Date(Date.now() - 999 * 60000).toISOString()
  await supabase.from('sincronizacoes_financeiro').insert({
    status: 'concluido', dry_run: false, iniciado_em: velho, concluido_em: velho,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: 0,
  })
}

beforeEach(async () => {
  await limparSincronizacoes()
  _resetCacheParaTeste()
  delete process.env.COBRANCA_EXIGE_SYNC
  delete process.env.COBRANCA_SYNC_MAX_ATRASO_MIN
  await supabase.from('automacoes_config').update({ cobranca_whatsapp_ativa: true }).eq('id', 1)
})

test('GET /api/cobrancas/status expõe sync_financeiro sem afetar cobranca_whatsapp_ativa', async (t) => {
  await t.test('sync fresco: allowed=true, last_sync_at presente, cobranca_whatsapp_ativa preservado', async () => {
    await inserirSyncFresco()
    const r = await fetch(`${base}/api/cobrancas/status`, { headers })
    const body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.cobranca_whatsapp_ativa, true)
    assert.equal(body.sync_financeiro.allowed, true)
    assert.equal(body.sync_financeiro.reason, null)
    assert.ok(body.sync_financeiro.last_sync_at)
  })

  await t.test('sync stale: allowed=false, reason=sync_stale, last_sync_at presente', async () => {
    await inserirSyncStale()
    const r = await fetch(`${base}/api/cobrancas/status`, { headers })
    const body = await r.json()
    assert.equal(r.status, 200)
    assert.equal(body.sync_financeiro.allowed, false)
    assert.equal(body.sync_financeiro.reason, 'sync_stale')
    assert.ok(body.sync_financeiro.last_sync_at)
    assert.ok(body.sync_financeiro.age_minutes > body.sync_financeiro.max_age_minutes)
  })

  await t.test('nunca sincronizou: allowed=false, reason=nunca_sincronizou, last_sync_at=null', async () => {
    const r = await fetch(`${base}/api/cobrancas/status`, { headers })
    const body = await r.json()
    assert.equal(body.sync_financeiro.allowed, false)
    assert.equal(body.sync_financeiro.reason, 'nunca_sincronizou')
    assert.equal(body.sync_financeiro.last_sync_at, null)
  })

  await t.test('régua pausada (cobranca_whatsapp_ativa=false) continua reportado corretamente, independente do guard', async () => {
    await inserirSyncFresco()
    await supabase.from('automacoes_config').update({ cobranca_whatsapp_ativa: false }).eq('id', 1)
    const r = await fetch(`${base}/api/cobrancas/status`, { headers })
    const body = await r.json()
    assert.equal(body.cobranca_whatsapp_ativa, false)
    assert.equal(body.sync_financeiro.allowed, true, 'guard e kill-switch são independentes — um não deve mascarar o outro')
  })

  await t.test('rota continua 100% leitura — não mutou automacoes_config nem sincronizacoes_financeiro', async () => {
    await inserirSyncFresco()
    const { count: antes } = await supabase.from('sincronizacoes_financeiro').select('id', { count: 'exact', head: true })
    await fetch(`${base}/api/cobrancas/status`, { headers })
    const { count: depois } = await supabase.from('sincronizacoes_financeiro').select('id', { count: 'exact', head: true })
    assert.equal(depois, antes)
  })

  await t.test('sem autenticação: 401, nunca vaza status', async () => {
    const r = await fetch(`${base}/api/cobrancas/status`)
    assert.equal(r.status, 401)
  })
})
