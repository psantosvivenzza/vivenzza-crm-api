// FASE B.1 (homologação, 2026-08-11) — CollectionShadowReadRepository.
// Única porta de entrada de LEITURA usada pelo CollectionShadowObserver
// (collection-shadow.js). Deliberadamente não exporta nenhum método de
// escrita (inserir, atualizar, apagar, enviar, despachar, quitar, prometer,
// negociar) — isso não é só uma convenção de nome, é literal: este arquivo só
// usa o verbo de leitura do query builder. Um teste automatizado
// (shadow-architecture.test.mjs) verifica isso via varredura do próprio
// arquivo, não confia só em revisão manual.
import { supabase } from '../../supabase-admin.server.js'

// Amostra controlada e determinística — mesma ordem sempre para o mesmo
// `limit` (por id, estável), nunca aleatória entre execuções.
export async function getEligibleAccounts(limit) {
  const { data, error } = await supabase
    .from('contas_financeiras')
    .select('id, valor, valor_pago, vencimento, pessoa_nome, codigo_cliente, telefone_cobranca, status, em_revisao_financeira')
    .eq('tipo', 'receber')
    .in('status', ['aberta', 'vencida', 'pago_parcial'])
    .order('id', { ascending: true })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function getCustomerReceivables(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('contas_financeiras')
    .select('id, valor, valor_pago, vencimento, pessoa_nome, codigo_cliente, telefone_cobranca, status')
    .eq('id', contasFinanceirasId)
    .single()
  if (error) throw error
  return data
}

export async function getPaymentHistory(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('baixas_financeiras')
    .select('valor_baixado, data_pagamento, forma_pagamento')
    .eq('conta_financeira_id', contasFinanceirasId)
    .eq('status', 'ativa')
  if (error) throw error
  return data ?? []
}

export async function getExistingPromisesReadOnly(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('collection_promises')
    .select('id, valor, promised_date, status, origem')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) throw error
  return data ?? []
}

// "Estado de cobrança atual" = os últimos score/NBA já calculados para o
// título (histórico, não recalcula) — usado para exibição/telemetria, não
// para decisão (a decisão sempre recalcula, via recoveryScore.js/nextBestAction.js).
export async function getCurrentCollectionState(contasFinanceirasId) {
  const [{ data: recovery }, { data: priority }, { data: nba }] = await Promise.all([
    supabase.from('collection_recovery_scores').select('score, calculado_em').eq('contas_financeiras_id', contasFinanceirasId).order('calculado_em', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('collection_priority_scores').select('score, calculado_em').eq('contas_financeiras_id', contasFinanceirasId).order('calculado_em', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('nba_shadow_log').select('nba_suggested_action, criado_em').eq('contas_financeiras_id', contasFinanceirasId).order('criado_em', { ascending: false }).limit(1).maybeSingle(),
  ])
  return { ultimoRecoveryScore: recovery ?? null, ultimoPriorityScore: priority ?? null, ultimaNbaShadow: nba ?? null }
}

export async function getRecentInteractions(contasFinanceirasId, { limite = 10 } = {}) {
  const { data, error } = await supabase
    .from('collection_timeline_events')
    .select('tipo, origem, descricao, criado_em')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .order('criado_em', { ascending: false })
    .limit(limite)
  if (error) throw error
  return data ?? []
}
