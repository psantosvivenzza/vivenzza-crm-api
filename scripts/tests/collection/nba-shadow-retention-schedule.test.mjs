// 2026-08-15 — agendamento da retenção do nba_shadow_log
// (nba-shadow-retention-cleanup.js). Cobre os 4 cenários pedidos: registro
// dentro da retenção permanece, registro antigo é elegível/removido,
// outras tabelas continuam intocadas, execução repetida é segura (idempotente).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

test('nba-shadow-retention-cleanup: remove só o antigo, preserva o resto, idempotente', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { runNbaShadowRetentionCleanup } = await import('../../../src/jobs/nba-shadow-retention-cleanup.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  await t.test('registro dentro da retenção permanece; registro mais antigo que a retenção é removido', async () => {
    await supabase.from('automacoes_config').update({ nba_shadow_log_retention_days: 90 }).eq('id', 1)
    invalidarCacheFlags()

    const conta = await criarContaDeTeste(supabase)
    const antigo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString() // 100 dias atrás
    const { data: linhaAntiga } = await supabase.from('nba_shadow_log').insert({
      contas_financeiras_id: conta.id, nba_suggested_action: 'NO_ACTION', criado_em: antigo,
    }).select().single()
    const { data: linhaRecente } = await supabase.from('nba_shadow_log').insert({
      contas_financeiras_id: conta.id, nba_suggested_action: 'NO_ACTION',
    }).select().single()

    const resultado = await runNbaShadowRetentionCleanup()
    assert.equal(resultado.preview, false)
    assert.ok(resultado.removidas >= 1)

    const { data: aindaTemAntiga } = await supabase.from('nba_shadow_log').select('id').eq('id', linhaAntiga.id).maybeSingle()
    assert.equal(aindaTemAntiga, null, 'linha com mais de 90 dias deveria ter sido removida')

    const { data: aindaTemRecente } = await supabase.from('nba_shadow_log').select('id').eq('id', linhaRecente.id).maybeSingle()
    assert.ok(aindaTemRecente, 'linha recente (dentro da janela de 90 dias) nunca deveria ser removida')
  })

  await t.test('outras tabelas continuam intocadas (scores, contas_financeiras, cobrancas_whatsapp, collection_dispatches)', async () => {
    const conta = await criarContaDeTeste(supabase)
    await supabase.from('nba_shadow_log').insert({
      contas_financeiras_id: conta.id, nba_suggested_action: 'NO_ACTION',
      criado_em: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
    })
    await supabase.from('collection_recovery_scores').insert({
      contas_financeiras_id: conta.id, score: 50, formula_version: 'teste', componentes: {}, explicacao: 'x',
    })

    const { count: contasAntes } = await supabase.from('contas_financeiras').select('id', { count: 'exact', head: true })
    const { count: scoresAntes } = await supabase.from('collection_recovery_scores').select('id', { count: 'exact', head: true })
    const { count: cobrancasAntes } = await supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true })
    const { count: dispatchesAntes } = await supabase.from('collection_dispatches').select('id', { count: 'exact', head: true })

    await runNbaShadowRetentionCleanup()

    const { count: contasDepois } = await supabase.from('contas_financeiras').select('id', { count: 'exact', head: true })
    const { count: scoresDepois } = await supabase.from('collection_recovery_scores').select('id', { count: 'exact', head: true })
    const { count: cobrancasDepois } = await supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true })
    const { count: dispatchesDepois } = await supabase.from('collection_dispatches').select('id', { count: 'exact', head: true })

    assert.equal(contasDepois, contasAntes, 'contas_financeiras nunca deveria ser tocada pela limpeza')
    assert.equal(scoresDepois, scoresAntes, 'collection_recovery_scores (score atual) nunca deveria ser tocada')
    assert.equal(cobrancasDepois, cobrancasAntes, 'cobrancas_whatsapp nunca deveria ser tocada')
    assert.equal(dispatchesDepois, dispatchesAntes, 'collection_dispatches nunca deveria ser tocada')
  })

  await t.test('execução repetida é segura — 2ª chamada sem nada novo pra remover não erra, não remove de novo', async () => {
    const r1 = await runNbaShadowRetentionCleanup()
    const r2 = await runNbaShadowRetentionCleanup()
    assert.equal(r2.removidas, 0, 'nada novo passou da janela de retenção entre as duas chamadas — 2ª execução não deveria remover nada')
  })

  await pararAmbienteDeTeste()
})
