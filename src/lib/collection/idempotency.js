// Idempotência de eventos externos (webhooks Evolution API, e futuramente outros
// provedores) — grava em integration_events ANTES de processar; se o mesmo evento
// já foi processado (ou está em processamento), o chamador deve pular.
//
// Padrão de uso (ver src/routes/webhook-handler.js para o fluxo completo):
//   const { novo, id } = await registrarEventoExterno({ provider: 'evolution', eventType: 'messages.update', externalId: `messages.update:${msgId}:${status}`, payload })
//   if (!novo) return // já processado ou em processamento — nada a fazer
//   ... processa ...
//   await marcarEventoProcessado(id)
import crypto from 'crypto'
import { supabase } from '../supabase-admin.server.js'

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex')
}

// Retorna { novo: true, id } se este é o primeiro registro deste evento (o chamador
// deve processar); { novo: false } se já existia (duplicata — reentrega de webhook,
// restart de worker no meio do processamento, etc).
export async function registrarEventoExterno({ provider, eventType, externalId, payload }) {
  const payloadHash = hashPayload(payload)

  const { data, error } = await supabase
    .from('integration_events')
    .insert({ provider, event_type: eventType, external_id: externalId, payload_hash: payloadHash })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation no índice (provider, event_type, external_id) —
    // é exatamente o caso de duplicata, não um erro real.
    if (error.code === '23505') return { novo: false }
    throw error
  }

  return { novo: true, id: data.id }
}

export async function marcarEventoProcessado(id, { status = 'processed', error = null } = {}) {
  await supabase
    .from('integration_events')
    .update({ processed_at: new Date().toISOString(), processing_status: status, error })
    .eq('id', id)
}

// Idempotency key determinística para dispatches de cobrança — mesma (título,
// etapa, dia) nunca gera dois collection_dispatches, mesmo se o cron rodar duas
// vezes por engano ou o worker reiniciar no meio de uma execução. `dia` usa a data
// BRT (não UTC) para casar com a janela de envio 08h-17h BRT.
export function idempotencyKeyDispatch({ contasFinanceirasId, etapa, diaBrt }) {
  return `cobranca:${contasFinanceirasId}:etapa${etapa}:${diaBrt}`
}

// FASE C.3A.1 (homologação) — idempotência de dispatch TÉCNICO (INTERNAL_TEST,
// nunca ligado a título real). Deliberadamente SEM componente de dia — ao
// contrário de idempotencyKeyDispatch(), o mesmo testKey nunca pode gerar um
// 2º envio real, nem em outro dia, nem depois de reiniciar o processo. Isso é
// "one-shot pra sempre" por construção (mesma UNIQUE INDEX de idempotency_key
// que já protege collection_dispatches, sem precisar de mecanismo novo).
export function idempotencyKeyInternalTest(testKey) {
  return `internal_test:${testKey}`
}

// 2026-08-16 — prontidão SIP trunk externo (Nvoip): mesma (título, dia) nunca
// pode gerar duas decisões de ligar simultâneas — retry de SIP/origination
// não pode duplicar. Mesmo padrão de idempotencyKeyDispatch() (1 por dia,
// não por etapa — uma ligação não tem "etapa" como o WhatsApp). Só a chave;
// quem aplica (voice_calls.idempotency_key UNIQUE, já existe na migration
// collection_v2_calls_operators/voice_calls_audit) e o guard puro que a usa
// (externalPilotGuardrails.js/avaliarIdempotencia) já existem — isto só
// fecha a lacuna de COMO gerar a chave de forma determinística.
export function idempotencyKeyLigacaoExterna({ contasFinanceirasId, diaBrt }) {
  return `ligacao_externa:${contasFinanceirasId}:${diaBrt}`
}
