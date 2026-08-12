// FASE C.3A.1 (homologação, 2026-08-12) — webhook-handler.js agora propaga
// ACK de entrega/leitura pra collection_dispatch_attempts (aplicarAckDeEntrega,
// já existente em dispatchEngine.js desde a B/C.1 — só a CHAMADA é nova aqui).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

async function criarDispatchComTentativa(supabase, { providerMessageId, status = 'sent' }) {
  const conta = await criarContaDeTeste(supabase)
  const { data: dispatch } = await supabase.from('collection_dispatches').insert({
    contas_financeiras_id: conta.id, etapa: 3, canal: 'whatsapp',
    idempotency_key: `webhook-teste:${conta.id}:${Date.now()}`, origem: 'manual',
    status, mensagem: 'x', cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca,
  }).select().single()
  const { data: tentativa } = await supabase.from('collection_dispatch_attempts').insert({
    dispatch_id: dispatch.id, attempt_number: 1, status, provider_message_id: providerMessageId,
  }).select().single()
  return { dispatch, tentativa }
}

test('webhook-handler.js: propagação de ACK pra collection_dispatch_attempts', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { processWhatsappEvent } = await import('../../../src/routes/webhook-handler.js')

  await t.test('1. provider_message_id conhecido → atualiza a tentativa correta (SERVER_ACK → sent, mantém)', async () => {
    await limparInstanciasDeTeste(supabase)
    const msgId = `msg-${Date.now()}-1`
    const { tentativa } = await criarDispatchComTentativa(supabase, { providerMessageId: msgId, status: 'sent' })

    await processWhatsappEvent({ event: 'messages.update', data: { keyId: msgId, status: 'DELIVERY_ACK' } })

    const { data: atualizada } = await supabase.from('collection_dispatch_attempts').select('status, entregue_em').eq('id', tentativa.id).single()
    assert.equal(atualizada.status, 'delivered')
    assert.ok(atualizada.entregue_em)
  })

  await t.test('2. Evento duplicado (mesmo ACK 2x) é idempotente — não duplica nem lança', async () => {
    const msgId = `msg-${Date.now()}-2`
    const { tentativa } = await criarDispatchComTentativa(supabase, { providerMessageId: msgId, status: 'sent' })

    await processWhatsappEvent({ event: 'messages.update', data: { keyId: msgId, status: 'DELIVERY_ACK' } })
    await processWhatsappEvent({ event: 'messages.update', data: { keyId: msgId, status: 'DELIVERY_ACK' } })

    const { data: atualizada } = await supabase.from('collection_dispatch_attempts').select('status').eq('id', tentativa.id).single()
    assert.equal(atualizada.status, 'delivered')
  })

  await t.test('3. Evento atrasado (SERVER_ACK depois de DELIVERY_ACK) NÃO regride o status', async () => {
    const msgId = `msg-${Date.now()}-3`
    const { tentativa } = await criarDispatchComTentativa(supabase, { providerMessageId: msgId, status: 'sent' })

    await processWhatsappEvent({ event: 'messages.update', data: { keyId: msgId, status: 'READ' } })
    await processWhatsappEvent({ event: 'messages.update', data: { keyId: msgId, status: 'SERVER_ACK' } }) // atrasado

    const { data: atualizada } = await supabase.from('collection_dispatch_attempts').select('status').eq('id', tentativa.id).single()
    assert.equal(atualizada.status, 'read', 'READ não pode regredir pra sent por causa de um SERVER_ACK atrasado')
  })

  await t.test('4. provider_message_id DESCONHECIDO não altera nenhuma tentativa existente', async () => {
    const msgIdReal = `msg-${Date.now()}-4-real`
    const { tentativa } = await criarDispatchComTentativa(supabase, { providerMessageId: msgIdReal, status: 'sent' })

    await assert.doesNotReject(() => processWhatsappEvent({ event: 'messages.update', data: { keyId: `msg-${Date.now()}-4-desconhecido`, status: 'DELIVERY_ACK' } }))

    const { data: inalterada } = await supabase.from('collection_dispatch_attempts').select('status').eq('id', tentativa.id).single()
    assert.equal(inalterada.status, 'sent', 'tentativa real não deveria ter sido tocada por um ACK de outra mensagem')
  })

  await t.test('5. Webhook legado (evento sem nenhuma tentativa do motor novo correlacionada) continua processando sem lançar', async () => {
    // Schema local de vivenzza_dev tem whatsapp_mensagens como stub mínimo
    // (só id) — não dá pra montar o mesmo cenário de produção 1:1 aqui. O que
    // importa pra este teste é a garantia estrutural: um evento de ACK
    // legítimo, sem NENHUM provider_message_id correspondente em
    // collection_dispatch_attempts, nunca pode derrubar o processamento do
    // webhook (aplicarAckDeEntrega é sempre try/catch, nunca propaga erro).
    const msgId = `msg-legado-${Date.now()}`
    await assert.doesNotReject(() => processWhatsappEvent({ event: 'messages.update', data: { keyId: msgId, status: 'READ' } }))
  })

  await t.test('6. Processar um ACK nunca dispara um novo envio real', async () => {
    const fakeEvolution = await iniciarAmbienteDeTeste()
    fakeEvolution.resetar()
    const msgId = `msg-${Date.now()}-6`
    await criarDispatchComTentativa(supabase, { providerMessageId: msgId, status: 'sent' })

    await processWhatsappEvent({ event: 'messages.update', data: { keyId: msgId, status: 'DELIVERY_ACK' } })
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
  })

  await pararAmbienteDeTeste()
})
