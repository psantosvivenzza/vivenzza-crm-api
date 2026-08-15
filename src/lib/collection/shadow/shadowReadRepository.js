// FASE B.1 (homologação, 2026-08-11) — CollectionShadowReadRepository.
// Única porta de entrada de LEITURA usada pelo CollectionShadowObserver
// (collection-shadow.js). Deliberadamente não exporta nenhum método de
// escrita (inserir, atualizar, apagar, enviar, despachar, quitar, prometer,
// negociar) — isso não é só uma convenção de nome, é literal: este arquivo só
// usa o verbo de leitura do query builder. Um teste automatizado
// (shadow-architecture.test.mjs) verifica isso via varredura do próprio
// arquivo, não confia só em revisão manual.
import { supabase } from '../../supabase-admin.server.js'

const COLUNAS_CONTA = 'id, valor, valor_pago, vencimento, pessoa_nome, codigo_cliente, telefone_cobranca, status, em_revisao_financeira'

function queryContasElegiveis() {
  return supabase
    .from('contas_financeiras')
    .select(COLUNAS_CONTA)
    .eq('tipo', 'receber')
    .in('status', ['aberta', 'vencida', 'pago_parcial'])
    .order('id', { ascending: true })
}

// 2026-08-15 — achado real: getEligibleAccounts (versão anterior) ordenava
// por id ASC LIMIT `limit` SEM cursor — sempre as mesmas ~50 contas de menor
// UUID da carteira inteira, nunca cobria o resto (carteira real tem 1.161+
// títulos em aberto). Substituída por keyset pagination com cursor
// persistido (collection_shadow_cursor, singleton id=1): cada ciclo pega a
// próxima fatia (id > cursor) e, se a carteira ordenada acabar antes de
// preencher `limit`, completa voltando pro início (wrap-around) — nunca
// menos que `limit` contas por ciclo quando a carteira tiver `limit` ou mais
// elegíveis, e cobre a carteira inteira em ceil(carteira/limit) ciclos.
// Cursor puramente sequencial por id — nunca aleatório, sempre auditável (dá
// pra saber exatamente "por onde" o shadow está só olhando a tabela).
// Só LEITURA aqui (lê a posição do cursor); persistir a nova posição é
// responsabilidade de shadowWriteRepository.js (persistShadowCursor), nunca
// misturado nesta função — mesma fronteira leitura/escrita do resto do
// arquivo.
export async function getEligibleAccountsRotativo(limit) {
  const { data: cursorRow, error: erroCursor } = await supabase
    .from('collection_shadow_cursor')
    .select('ultimo_id_processado')
    .eq('id', 1)
    .maybeSingle()
  if (erroCursor) throw erroCursor
  const cursor = cursorRow?.ultimo_id_processado ?? null

  let query = queryContasElegiveis().limit(limit)
  if (cursor) query = query.gt('id', cursor)
  const { data: primeiraLeva, error: erro1 } = await query
  if (erro1) throw erro1

  let contas = primeiraLeva ?? []

  if (contas.length < limit) {
    const faltam = limit - contas.length
    const { data: voltaAoInicio, error: erro2 } = await queryContasElegiveis().limit(limit)
    if (erro2) throw erro2
    const jaIncluidos = new Set(contas.map((c) => c.id))
    const complemento = (voltaAoInicio ?? []).filter((c) => !jaIncluidos.has(c.id)).slice(0, faltam)
    contas = contas.concat(complemento)
  }

  const proximoCursor = contas.length ? contas[contas.length - 1].id : null
  return { contas, proximoCursor }
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
