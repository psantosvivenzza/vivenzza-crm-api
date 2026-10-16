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
  try {
    const resultado = await varrerTitulosPendentesEcancelarQuitados()
    console.log('[payment-reconciliation-sweep] concluído:', resultado)
    return resultado
  } catch (error) {
    // Sinal estável para monitoramento, sem mensagens/causas/IDs de títulos.
    // Não envia alerta externo nem converte falha em execução bem-sucedida.
    const parcial = error?.code === 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE'
    const contagem = campo => {
      const valor = error?.resultado?.[campo]
      return Number.isSafeInteger(valor) && valor >= 0 ? valor : null
    }
    console.error('[payment-reconciliation-sweep] falha:', {
      code: parcial ? 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE' : 'PAYMENT_RECONCILIATION_FAILURE',
      verificados: contagem('verificados'),
      quitados: contagem('quitados'),
      falhas: contagem('falhas'),
    })
    throw error
  }
}
