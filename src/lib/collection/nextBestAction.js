// FASE 5 — NextBestCollectionAction. Decide QUAL ação tomar para um título, com
// reason_codes explícitos — nunca "caixa preta". A régua D-3..D+60 continua sendo a
// CAMADA BASE (calcula a etapa/elegibilidade); o NBA decide o CANAL considerando
// dias + valor + recuperabilidade + prioridade + resposta + promessa + tentativas —
// só quando `next_best_action=true` (senão o chamador usa direto WHATSAPP/régua,
// comportamento idêntico ao pré-reforma).
//
// Saída sempre inclui reason_codes (ex: ['HIGH_VALUE','BROKEN_PROMISE']) — nunca
// decide silenciosamente.
import { supabase } from '../supabase-admin.server.js'
import { calcularEtapa } from '../reguaCobranca.js'
import { diasAtrasoDe } from './collectionContactPolicy.js'
import { promessaAtivaPara } from './promises.js'
import { ultimoRecoveryScore } from './recoveryScore.js'
import { ultimoPriorityScore } from './priorityScore.js'
import { obterConfigCobranca } from './featureFlags.js'

export const ACAO = Object.freeze({
  NO_ACTION: 'NO_ACTION',
  WHATSAPP: 'WHATSAPP',
  AI_WHATSAPP: 'AI_WHATSAPP',
  AI_CALL: 'AI_CALL',
  HUMAN_CALL: 'HUMAN_CALL',
  WAIT_PROMISE: 'WAIT_PROMISE',
  PAYMENT_CHECK: 'PAYMENT_CHECK',
  HUMAN_REVIEW: 'HUMAN_REVIEW',
})

async function estaEmOptOut(clienteTelefone) {
  if (!clienteTelefone) return false
  const { data } = await supabase
    .from('collection_do_not_contact')
    .select('id')
    .eq('cliente_telefone', clienteTelefone)
    .in('canal', ['todos', 'whatsapp'])
    .limit(1)
  return (data?.length ?? 0) > 0
}

async function houvePromessaQuebrada(contasFinanceirasId) {
  const { data } = await supabase
    .from('collection_promises')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .eq('status', 'quebrada')
    .limit(1)
  return (data?.length ?? 0) > 0
}

export async function decidirProximaAcao(contasFinanceirasId) {
  const { data: titulo, error } = await supabase
    .from('contas_financeiras')
    .select('*')
    .eq('id', contasFinanceirasId)
    .single()
  if (error) throw error

  const saldo = Number(titulo.valor || 0) - Number(titulo.valor_pago || 0)
  if (saldo <= 0) return { acao: ACAO.NO_ACTION, reason_codes: ['TITULO_QUITADO'] }
  if (titulo.status === 'cancelada') return { acao: ACAO.NO_ACTION, reason_codes: ['TITULO_CANCELADO'] }
  if (titulo.em_revisao_financeira) return { acao: ACAO.HUMAN_REVIEW, reason_codes: ['EM_REVISAO_FINANCEIRA'] }

  if (await estaEmOptOut(titulo.telefone_cobranca)) {
    return { acao: ACAO.NO_ACTION, reason_codes: ['OPT_OUT'] }
  }

  const promessa = await promessaAtivaPara(contasFinanceirasId)
  if (promessa) return { acao: ACAO.WAIT_PROMISE, reason_codes: ['PROMESSA_ATIVA'], promessa }

  const diasAtraso = diasAtrasoDe(titulo.vencimento)
  const etapa = calcularEtapa(diasAtraso)
  if (etapa === null) return { acao: ACAO.NO_ACTION, reason_codes: ['FORA_DA_REGUA'] }

  if (!titulo.telefone_cobranca) return { acao: ACAO.HUMAN_REVIEW, reason_codes: ['SEM_TELEFONE'] }

  const [recovery, priority, teveQuebra] = await Promise.all([
    ultimoRecoveryScore(contasFinanceirasId),
    ultimoPriorityScore(contasFinanceirasId),
    houvePromessaQuebrada(contasFinanceirasId),
  ])
  const config = await obterConfigCobranca()

  const reasonCodes = []
  if (priority?.score >= 70) reasonCodes.push('HIGH_PRIORITY')
  if (priority?.componentes?.valor_divida?.valor >= priority?.componentes?.valor_divida?.maximo * 0.7) reasonCodes.push('HIGH_VALUE')
  if (teveQuebra) reasonCodes.push('BROKEN_PROMISE')
  if (recovery?.score >= 70) reasonCodes.push('HIGH_RECOVERABILITY')
  if (recovery?.score != null && recovery.score < 30) reasonCodes.push('LOW_RECOVERABILITY')
  if (etapa >= 7) reasonCodes.push('LATE_STAGE')
  if (!reasonCodes.length) reasonCodes.push('ROTINA_REGUA')

  // Árvore de decisão determinística — nenhuma parte é aprendida/inferida por IA.
  if (teveQuebra && priority?.score >= 60 && config.ai_voice_calls) {
    return { acao: ACAO.AI_CALL, reason_codes: reasonCodes, etapa, diasAtraso }
  }
  if (etapa >= 7 && priority?.score >= 80 && config.human_call_alerts) {
    return { acao: ACAO.HUMAN_CALL, reason_codes: [...reasonCodes, 'REQUER_ATENCAO_HUMANA'], etapa, diasAtraso }
  }
  if (recovery?.score != null && recovery.score < 20 && etapa >= 7) {
    // Baixíssima recuperabilidade + estágio avançado: continuar insistindo via
    // automação tem baixo retorno — melhor revisão humana (ex: negativação,
    // encerramento de relação comercial) do que mais mensagens automáticas.
    return { acao: ACAO.HUMAN_REVIEW, reason_codes: [...reasonCodes, 'BAIXA_RECUPERABILIDADE_ESTAGIO_AVANCADO'], etapa, diasAtraso }
  }
  if (config.ai_whatsapp) {
    return { acao: ACAO.AI_WHATSAPP, reason_codes: reasonCodes, etapa, diasAtraso }
  }
  return { acao: ACAO.WHATSAPP, reason_codes: reasonCodes, etapa, diasAtraso }
}

// Ranking da fila diária — não pega os N primeiros cronologicamente (comportamento
// antigo, "arbitrário" segundo a auditoria); ordena por priority_score DESC entre
// os elegíveis. Usado pelo job v2 (collection-engine.js) quando priority_score=true.
export function ordenarPorPrioridade(candidatos) {
  return [...candidatos].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
}
