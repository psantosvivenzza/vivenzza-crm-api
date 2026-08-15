// FASE B.1 (homologação, 2026-08-11) — CollectionShadowWriteRepository.
// Única porta de entrada de ESCRITA usada pelo CollectionShadowObserver.
// Escreve exclusivamente na tabela de log de NBA shadow (mais, se SHADOW 2 for
// autorizado depois, na de sugestões de IA shadow) — nunca em qualquer tabela
// financeira ou operacional do sistema. Verificado por
// shadow-architecture.test.mjs (varredura automatizada do próprio arquivo,
// não confia só em revisão manual).
import { supabase } from '../../supabase-admin.server.js'

export async function persistNbaShadowDecision({ contasFinanceirasId, nbaSuggestedAction, nbaReasonCodes, legacyAction, recoveryScore, priorityScore }) {
  const { error } = await supabase.from('nba_shadow_log').insert({
    contas_financeiras_id: contasFinanceirasId, nba_suggested_action: nbaSuggestedAction, nba_reason_codes: nbaReasonCodes,
    legacy_action: legacyAction, recovery_score: recoveryScore, priority_score: priorityScore,
  })
  if (error) throw error
}

// 2026-08-15 — persiste a posição do cursor de rotação (collection_shadow_cursor,
// singleton id=1) depois de um ciclo processar um lote via
// getEligibleAccountsRotativo() (shadowReadRepository.js). Separado por
// propósito: a leitura decide o lote e SUGERE o próximo cursor, mas nunca
// escreve; só este write model persiste de fato.
export async function persistShadowCursor(proximoCursor) {
  const { error } = await supabase
    .from('collection_shadow_cursor')
    .update({ ultimo_id_processado: proximoCursor, atualizado_em: new Date().toISOString() })
    .eq('id', 1)
  if (error) throw error
}

// 2026-08-15 — retenção do nba_shadow_log. Existe (testada) mas NÃO é
// chamada por nenhum cron/rota — ligar isso a um agendamento é decisão
// operacional separada, autorizada à parte, depois de rodar em preview.
// `preview=true` (default) nunca apaga — só conta quantas linhas seriam
// removidas, pra decidir com dado real antes de qualquer DELETE de verdade.
export async function cleanupNbaShadowLog({ retentionDays, preview = true } = {}) {
  const limite = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  if (preview) {
    const { count, error } = await supabase
      .from('nba_shadow_log')
      .select('id', { count: 'exact', head: true })
      .lt('criado_em', limite)
    if (error) throw error
    return { preview: true, removeriam: count ?? 0, limiteData: limite }
  }

  const { data, error } = await supabase.from('nba_shadow_log').delete().lt('criado_em', limite).select('id')
  if (error) throw error
  return { preview: false, removidas: data?.length ?? 0, limiteData: limite }
}

// Placeholder documentado para SHADOW 2 (IA) — não usado enquanto ai_shadow_mode
// não for autorizado/deployado; existe aqui só para deixar explícita a fronteira
// exata do que o write model TERIA permissão de fazer quando essa fase chegar,
// sem precisar adicionar mais um arquivo depois.
export async function persistAiShadowSuggestion() {
  throw new Error('persistAiShadowSuggestion: SHADOW 2 (IA) não está no escopo desta migration mínima — tabela ai_shadow_suggestions não existe no deploy atual.')
}
