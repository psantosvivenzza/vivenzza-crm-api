// FASE B.5 (homologação, 2026-08-11) — modelo final de recomendação
// (channel + handler, com recommended_action sempre DERIVADO dos dois) e
// calibração: gate de status do cliente ERP (ATIVO/INATIVO/DESCONHECIDO)
// integrado no NBA shadow, promessas continuam WAIT_PROMISE/recalculando
// prioridade via BROKEN_PROMISE, zero efeito externo em qualquer caso.
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

test('NBA shadow B.5: modelo channel+handler, gate de cliente ERP, zero efeito externo', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { avaliarNbaShadow } = await import('../../../src/lib/collection/nextBestActionShadow.js')
  const { decidirProximaAcao, derivarAcao, CANAL, EXECUTOR } = await import('../../../src/lib/collection/nextBestAction.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  async function setFlags(flags) {
    await supabase.from('automacoes_config').update(flags).eq('id', 1)
    invalidarCacheFlags()
  }

  const contasCriadasNesteArquivo = []
  async function criarConta(overrides) {
    const conta = await criarContaDeTeste(supabase, overrides)
    contasCriadasNesteArquivo.push(conta.id)
    return conta
  }

  await t.test('1. cliente pago (saldo zero) → channel=NONE, handler=NONE, action=NO_ACTION', async () => {
    const conta = await criarConta({ valor: 500, valor_pago: 500 })
    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_channel, CANAL.NONE)
    assert.equal(shadow.recommended_handler, EXECUTOR.NONE)
    assert.equal(shadow.recommended_action, 'NO_ACTION')
  })

  await t.test('2. DNC → channel=NONE, handler=NONE, action=NO_ACTION', async () => {
    const conta = await criarConta({})
    await supabase.from('collection_do_not_contact').insert({ cliente_telefone: conta.telefone_cobranca, canal: 'todos', motivo: 'teste' })
    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_channel, CANAL.NONE)
    assert.equal(shadow.recommended_handler, EXECUTOR.NONE)
    assert.equal(shadow.recommended_action, 'NO_ACTION')
  })

  await t.test('3. contestação (em_revisao_financeira=true) → channel=REVIEW, handler=HUMAN, action=HUMAN_REVIEW', async () => {
    const conta = await criarConta({ em_revisao_financeira: true })
    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_channel, CANAL.REVIEW)
    assert.equal(shadow.recommended_handler, EXECUTOR.HUMAN)
    assert.equal(shadow.recommended_action, 'HUMAN_REVIEW')
    assert.equal(shadow.execution_available, true, 'REVIEW/HUMAN não depende de canal externo')
  })

  await t.test('4. cliente INATIVO → HUMAN_REVIEW mesmo quando o modelo canal-agnóstico normal recomendaria outro canal', async () => {
    const conta = await criarConta({ vencimento: diasAtras(1), clienteErpAtivo: false })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 40)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: true, ai_voice_calls: true, ai_whatsapp: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.cliente_erp_status, 'INATIVO')
    assert.equal(shadow.recommended_channel, CANAL.REVIEW)
    assert.equal(shadow.recommended_handler, EXECUTOR.HUMAN)
    assert.equal(shadow.recommended_action, 'HUMAN_REVIEW')
    assert.ok(shadow.reason_codes.includes('CLIENTE_INATIVO'))
    assert.equal(shadow.execution_available, true)
  })

  await t.test('5. cliente DESCONHECIDO (sem codigo_cliente) → HUMAN_REVIEW, nunca assume ativo por padrão', async () => {
    const conta = await criarConta({ vencimento: diasAtras(1), codigo_cliente: null })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 40)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: true, ai_voice_calls: true, ai_whatsapp: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.cliente_erp_status, 'DESCONHECIDO')
    assert.equal(shadow.recommended_channel, CANAL.REVIEW)
    assert.equal(shadow.recommended_handler, EXECUTOR.HUMAN)
    assert.equal(shadow.recommended_action, 'HUMAN_REVIEW')
    assert.ok(shadow.reason_codes.includes('CLIENTE_DESCONHECIDO'))
  })

  await t.test('6. cliente ATIVO com flags reais OFF: shadow ainda recomenda HUMAN_CALL (channel=CALL/handler=HUMAN), execution_available=false', async () => {
    const conta = await criarConta({ vencimento: diasAtras(35) }) // etapa 7, cliente ATIVO (default)
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 85)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, cobranca_whatsapp_ativa: true })

    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.cliente_erp_status, 'ATIVO')
    assert.equal(shadow.recommended_channel, CANAL.CALL)
    assert.equal(shadow.recommended_handler, EXECUTOR.HUMAN)
    assert.equal(shadow.recommended_action, derivarAcao(CANAL.CALL, EXECUTOR.HUMAN), 'recommended_action deve ser DERIVADO de channel+handler, não escolhido à parte')
    assert.equal(shadow.recommended_action, 'HUMAN_CALL')
    assert.equal(shadow.execution_available, false)
    assert.equal(shadow.execution_block_reason, 'HUMAN_CALL_DISABLED')
    assert.equal(shadow.channel_cost_class, 'HIGH')
  })

  await t.test('7. a mesma flag (human_call_alerts=false) impede execução real de HUMAN_CALL — comportamento inalterado', async () => {
    const conta = await criarConta({ vencimento: diasAtras(35) })
    await inserirScore(supabase, 'collection_priority_scores', conta.id, 85)
    await inserirScore(supabase, 'collection_recovery_scores', conta.id, 50)
    await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false, cobranca_whatsapp_ativa: true })

    const real = await decidirProximaAcao(conta.id)
    assert.notEqual(real.acao, 'HUMAN_CALL')
    assert.equal(real.acao, 'WHATSAPP')
  })

  await t.test('8. promessa ativa → channel=NONE, handler=AUTOMATION, action=WAIT_PROMISE', async () => {
    const conta = await criarConta({})
    await supabase.from('collection_promises').insert({
      contas_financeiras_id: conta.id, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca,
      valor: 100, promised_date: diasAtras(-5), origem: 'AUTOMATION', status: 'ativa',
    })
    const shadow = await avaliarNbaShadow(conta.id)
    assert.equal(shadow.recommended_channel, CANAL.NONE)
    assert.equal(shadow.recommended_handler, EXECUTOR.AUTOMATION)
    assert.equal(shadow.recommended_action, 'WAIT_PROMISE')
    assert.equal(shadow.execution_available, true)

    const real = await decidirProximaAcao(conta.id)
    assert.equal(real.acao, 'WAIT_PROMISE')
  })

  await t.test('9. zero ação externa em toda a suíte B.5 (WhatsApp real, ligação, IA)', async () => {
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nenhuma mensagem real deveria ter saído durante toda a suíte B.5')
    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').in('contas_financeiras_id', contasCriadasNesteArquivo)
    assert.equal((dispatches ?? []).length, 0)
    const { data: calls } = await supabase.from('collection_calls').select('id').in('contas_financeiras_id', contasCriadasNesteArquivo)
    assert.equal((calls ?? []).length, 0)
  })

  await setFlags({ human_call_alerts: false, ai_voice_calls: false, ai_whatsapp: false })
  await pararAmbienteDeTeste()
})
