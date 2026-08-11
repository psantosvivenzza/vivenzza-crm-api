// FASE B.5 (homologação, 2026-08-11) — threshold configurável de priority
// score para HUMAN_CALL (era 80 hardcoded, calibrado para 65 com dado real da
// carteira elegível completa). Prova: (1) o valor vem de config, não de
// constante fixa; (2) o limite é estrito — priority just below não vira
// HUMAN_CALL "por proximidade"; (3) muda só a RECOMENDAÇÃO shadow, a flag
// human_call_alerts continua sendo o único gate de execução real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

async function inserirScore(supabase, tabela, contasFinanceirasId, score) {
  const { error } = await supabase.from(tabela).insert({
    contas_financeiras_id: contasFinanceirasId, score, formula_version: 'teste', componentes: {}, explicacao: 'teste',
  })
  if (error) throw error
}

function diasAtras(n) {
  return new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
}

test('NBA shadow: threshold de HUMAN_CALL configurável (calibrado em 65)', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { avaliarNbaShadow } = await import('../../../src/lib/collection/nextBestActionShadow.js')
  const { decidirProximaAcao } = await import('../../../src/lib/collection/nextBestAction.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function setFlags(flags) {
    await supabase.from('automacoes_config').update(flags).eq('id', 1)
    invalidarCacheFlags()
  }

  await t.test('1. priority=65 (== default calibrado) + etapa>=7 → SHADOW recomenda HUMAN_CALL', async () => {
    const conta = await criarContaDeTeste(supabase, { vencimento: diasAtras(35) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 65)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_action, 'HUMAN_CALL', 'priority=65 deveria bater o threshold default calibrado (>=65)')
    assert.equal(shadow.execution_available, false)
    assert.equal(shadow.execution_block_reason, 'HUMAN_CALL_DISABLED')
  })

  await t.test('2. priority=64 (1 ponto abaixo) → SHADOW NÃO recomenda HUMAN_CALL só por proximidade', async () => {
    const conta = await criarContaDeTeste(supabase, { vencimento: diasAtras(35) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 64)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: true, ai_voice_calls: true, ai_whatsapp: true }) // mesmo com tudo ligado

    const shadow = await avaliarNbaShadow(conta.id)
    assert.notEqual(shadow.recommended_action, 'HUMAN_CALL', 'o limite é estrito — 1 ponto abaixo não deveria virar HUMAN_CALL nem no shadow')
    assert.equal(shadow.recommended_action, 'AI_WHATSAPP')
  })

  await t.test('3. threshold é configurável via automacoes_config, não constante fixa no código', async () => {
    const conta = await criarContaDeTeste(supabase, { vencimento: diasAtras(35) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 55)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    // Threshold customizado (não é o default 65) — se o código estivesse
    // hardcoded, mudar a config não teria efeito nenhum.
    await setFlags({ human_call_alerts: false, human_call_priority_threshold: 50 })

    const shadowComThresholdBaixo = await avaliarNbaShadow(conta.id)
    assert.equal(shadowComThresholdBaixo.recommended_action, 'HUMAN_CALL', 'com threshold=50 configurado, priority=55 deveria bater')

    await setFlags({ human_call_priority_threshold: 65 })
    const shadowComThresholdDefault = await avaliarNbaShadow(conta.id)
    assert.notEqual(shadowComThresholdDefault.recommended_action, 'HUMAN_CALL', 'voltando ao threshold 65, priority=55 não deveria mais bater')

    await setFlags({ human_call_priority_threshold: 65 })
  })

  await t.test('4. mesmo com priority>=threshold, human_call_alerts=false impede execução real — só muda a recomendação, nunca a execução', async () => {
    const conta = await criarContaDeTeste(supabase, { vencimento: diasAtras(35) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 90)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, human_call_priority_threshold: 65 })

    const real = await decidirProximaAcao(conta.id)
    assert.notEqual(real.acao, 'HUMAN_CALL', 'threshold calibrado não é autorização de execução — a flag continua sendo a barreira')
  })

  await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, human_call_priority_threshold: 65 })
  await pararAmbienteDeTeste()
})
