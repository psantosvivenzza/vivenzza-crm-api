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

// Allowlist de classes operacionais: nunca copiar código/mensagem arbitrária.
function classificarFalha(error) {
  switch (error?.code) {
    case 'PGRST202': return 'rpc_indisponivel' // função ausente OU cache desatualizado
    case '55P03': return 'timeout_lock'
    case '25001': return 'contexto_transacao'
    case '40P01': return 'deadlock'
    case '40001': return 'falha_serializacao'
    case '42501': return 'permissao_negada'
    case '42P01':
    case 'PGRST204':
    case 'PGRST205': return 'schema_incompativel'
    case '57014': return 'consulta_cancelada'
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case '08006': return 'conexao_indisponivel'
    case '23514': return 'integridade_dados'
    case 'P0001': return 'rejeicao_banco'
    default: return 'desconhecida'
  }
}

function diagnosticoSeguro(error) {
  const desconhecido = {
    code: 'PAYMENT_RECONCILIATION_FAILURE', causas: ['desconhecida'],
    verificados: null, quitados: null, falhas: null,
  }
  try {
    const parcial = error?.code === 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE'
    const diretos = error?.errors
    const erros = Array.isArray(diretos) && diretos.length ? diretos : [error]
    const resultado = error?.resultado
    const contagem = campo => {
      const valor = resultado?.[campo]
      return Number.isSafeInteger(valor) && valor >= 0 ? valor : null
    }
    return {
      code: parcial ? 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE' : 'PAYMENT_RECONCILIATION_FAILURE',
      causas: [...new Set(erros.map(classificarFalha))],
      verificados: contagem('verificados'),
      quitados: contagem('quitados'),
      falhas: contagem('falhas'),
    }
  } catch {
    // Getter/Proxy inesperado não pode substituir a falha original do sweep.
    return desconhecido
  }
}

export async function runPaymentReconciliationSweep() {
  try {
    const resultado = await varrerTitulosPendentesEcancelarQuitados()
    console.log('[payment-reconciliation-sweep] concluído:', resultado)
    return resultado
  } catch (error) {
    // Sinal estável para monitoramento, sem mensagens brutas/IDs de títulos.
    // Não envia alerta externo nem converte falha em execução bem-sucedida.
    try {
      console.error('[payment-reconciliation-sweep] falha:', diagnosticoSeguro(error))
    } catch {
      // Falha do logger também não deve mascarar a exceção original.
    }
    throw error
  }
}
