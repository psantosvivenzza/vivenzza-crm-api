// FASE B.1.2 (homologação, 2026-08-11) — prova do bug real encontrado e
// corrigido: nba_shadow_mode=true com score_shadow_mode=false precisa
// funcionar de verdade (ler o ÚLTIMO score já persistido, nunca recalcular),
// não ser um no-op silencioso como estava antes desta correção. Este é
// exatamente o cenário que a FASE B.1.2 em produção vai executar: reusar os
// scores da rodada B.1.1 sem rodar score_shadow_mode de novo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

test('NBA shadow roda de forma independente de score_shadow_mode, reusando score já persistido', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { runCollectionShadow } = await import('../../../src/jobs/collection-shadow.js')
  const { calcularEPersistirRecoveryScore } = await import('../../../src/lib/collection/recoveryScore.js')
  const { calcularEPersistirPriorityScore } = await import('../../../src/lib/collection/priorityScore.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  await t.test('nba_shadow_mode=true + score_shadow_mode=false, COM score pré-existente: NBA roda e reusa o score já persistido (não recalcula)', async () => {
    const conta = await criarContaDeTeste(supabase, { shadow_max_customers: undefined })
    const recovery = await calcularEPersistirRecoveryScore(conta.id)
    const priority = await calcularEPersistirPriorityScore(conta.id, { recoveryScore: recovery.score })

    const { data: scoresAntes } = await supabase.from('collection_recovery_scores').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(scoresAntes.length, 1, 'pré-condição: exatamente 1 score já persistido antes da rodada NBA')

    await supabase.from('automacoes_config').update({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 1000 }).eq('id', 1)
    invalidarCacheFlags()

    const resumo = await runCollectionShadow()
    assert.equal(resumo.pulado, undefined, 'não deveria pular — nba_shadow_mode=true é suficiente para rodar, mesmo com score_shadow_mode=false')
    assert.ok(resumo.comNba > 0, 'deveria ter calculado NBA para pelo menos 1 título (achado real corrigido: antes ficava comNba=0 sempre)')
    assert.equal(resumo.comScore, 0, 'score_shadow_mode=false: NBA não pode ter recalculado nenhum score novo')

    const { data: scoresDepois } = await supabase.from('collection_recovery_scores').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(scoresDepois.length, 1, 'NÃO pode ter criado um novo score — continua exatamente 1 (o mesmo de antes, reusado)')

    const { data: nbaLog } = await supabase.from('nba_shadow_log').select('*').eq('contas_financeiras_id', conta.id).maybeSingle()
    assert.ok(nbaLog, 'deveria ter gravado a decisão NBA')
    assert.equal(nbaLog.recovery_score, recovery.score, 'o log deve conter o score JÁ EXISTENTE (reusado), não um novo cálculo')
    assert.equal(nbaLog.priority_score, priority.score)

    await supabase.from('automacoes_config').update({ nba_shadow_mode: false, score_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
    invalidarCacheFlags()
  })

  await t.test('nba_shadow_mode=true + score_shadow_mode=false, SEM nenhum score pré-existente: NBA ainda roda (reason_codes ficam sem componente de score, sem quebrar)', async () => {
    const conta = await criarContaDeTeste(supabase, {})

    await supabase.from('automacoes_config').update({ nba_shadow_mode: true, score_shadow_mode: false, shadow_max_customers: 1000 }).eq('id', 1)
    invalidarCacheFlags()

    const resumo = await runCollectionShadow()
    assert.ok(resumo.comNba > 0)

    const { data: nbaLog } = await supabase.from('nba_shadow_log').select('*').eq('contas_financeiras_id', conta.id).maybeSingle()
    assert.ok(nbaLog, 'deveria gravar a decisão mesmo sem score prévio')
    assert.equal(nbaLog.recovery_score, null, 'sem score prévio, o campo fica null — nunca inventa/força um valor')
    assert.equal(nbaLog.priority_score, null)

    await supabase.from('automacoes_config').update({ nba_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
    invalidarCacheFlags()
  })

  await t.test('score_shadow_mode=true + nba_shadow_mode=false (cenário B.1.1 original): continua funcionando como antes, sem regressão', async () => {
    const conta = await criarContaDeTeste(supabase, {})
    await supabase.from('automacoes_config').update({ score_shadow_mode: true, nba_shadow_mode: false, shadow_max_customers: 1000 }).eq('id', 1)
    invalidarCacheFlags()

    const resumo = await runCollectionShadow()
    assert.ok(resumo.comScore > 0)
    assert.equal(resumo.comNba, 0, 'nba_shadow_mode=false: nenhuma decisão NBA deve ser calculada')

    const { data: nbaLog } = await supabase.from('nba_shadow_log').select('id').eq('contas_financeiras_id', conta.id).maybeSingle()
    assert.equal(nbaLog, null, 'nenhum log de NBA deve existir para esta conta')

    await supabase.from('automacoes_config').update({ score_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
    invalidarCacheFlags()
  })

  await pararAmbienteDeTeste()
})
