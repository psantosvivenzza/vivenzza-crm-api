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

export async function buscarSugestao(id) {
  const { data, error } = await supabase.from('ai_shadow_suggestions').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

const ACOES_FEEDBACK_VALIDAS = ['approved', 'edited', 'discarded']

// Feedback supervisionado — NUNCA envia WhatsApp, nunca cria cobrança, nunca
// altera o financeiro. suggested_reply (original da IA) é sempre preservado;
// em 'edited', o texto final do operador vai num campo separado
// (final_reply_operator) — o par (original, final) é a matéria-prima pra um
// aprendizado supervisionado futuro, não usado automaticamente por nada
// ainda. Em 'approved'/'discarded', final_reply_operator fica null — nada
// foi reescrito pelo operador.
export async function registrarFeedback(suggestionId, { action, finalReply, feedbackBy }) {
  if (!ACOES_FEEDBACK_VALIDAS.includes(action)) {
    throw new Error(`Ação de feedback inválida: ${action}`)
  }
  if (action === 'edited' && !(typeof finalReply === 'string' && finalReply.trim().length > 0)) {
    throw new Error('Feedback "edited" exige final_reply não vazio')
  }

  const { data, error } = await supabase.from('ai_shadow_suggestions').update({
    feedback_status: action,
    final_reply_operator: action === 'edited' ? finalReply : null,
    feedback_by: feedbackBy ?? null,
    feedback_at: new Date().toISOString(),
  }).eq('id', suggestionId).select().single()
  if (error) throw error
  return data
}
