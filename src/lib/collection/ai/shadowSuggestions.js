// IA WhatsApp MVP — persistência da sugestão (shadow). Esta tabela nunca é
// lida por nenhum fluxo de envio real (dispatchEngine.js/collectionRouting.js
// não a referenciam) — é puramente "IA sugere, operador vê", conforme pedido.
import { supabase } from '../../supabase-admin.server.js'

export async function registrarSugestao({
  contasFinanceirasId, clienteTelefone, mensagemCliente, intent, confidence, clienteIrritado,
  suggestedReply, recommendedAction, requiresHuman, reasonCodes, extractedDate, promiseCandidate,
  toolsRequested, aiProvider,
}) {
  const { data, error } = await supabase.from('ai_shadow_suggestions').insert({
    contas_financeiras_id: contasFinanceirasId,
    cliente_telefone: clienteTelefone,
    mensagem_cliente: mensagemCliente,
    intent,
    confidence,
    cliente_irritado: clienteIrritado,
    suggested_reply: suggestedReply,
    recommended_action: recommendedAction,
    requires_human: requiresHuman,
    reason_codes: reasonCodes,
    extracted_date: extractedDate,
    promise_candidate: promiseCandidate,
    tools_requested: toolsRequested,
    ai_provider: aiProvider,
  }).select().single()
  if (error) throw error
  return data
}

export async function listarSugestoes({ contasFinanceirasId, limit = 50 } = {}) {
  let query = supabase.from('ai_shadow_suggestions').select('*').order('criado_em', { ascending: false }).limit(limit)
  if (contasFinanceirasId) query = query.eq('contas_financeiras_id', contasFinanceirasId)
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}
