// 2026-09-01 — agendamento do sweep de pagamento tardio
// (varrerTitulosPendentesEcancelarQuitados, paymentGuard.js — já existia,
// nunca tinha scheduler ativo; o job antigo que o chamava está em
// quarentena). Pega o caso em que dispatch/ligação/promessa ficou pendente
// mas o título já não pode mais ser cobrado (pago/cancelado/em revisão)
// porque isso aconteceu DEPOIS do agendamento — corrida pagamento x job.
// Idempotente: nada de novo acontece numa segunda execução sobre o mesmo
// título (dispatch já 'cancelled', promessa já 'cumprida' não são
// recontados pelas queries de pendência).
import { varrerTitulosPendentesEcancelarQuitados } from '../lib/collection/paymentGuard.js'

export async function runPaymentReconciliationSweep() {
  const resultado = await varrerTitulosPendentesEcancelarQuitados()
  console.log('[payment-reconciliation-sweep] concluído:', resultado)
  return resultado
}
