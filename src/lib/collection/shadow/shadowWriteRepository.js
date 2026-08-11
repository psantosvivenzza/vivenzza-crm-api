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

// Placeholder documentado para SHADOW 2 (IA) — não usado enquanto ai_shadow_mode
// não for autorizado/deployado; existe aqui só para deixar explícita a fronteira
// exata do que o write model TERIA permissão de fazer quando essa fase chegar,
// sem precisar adicionar mais um arquivo depois.
export async function persistAiShadowSuggestion() {
  throw new Error('persistAiShadowSuggestion: SHADOW 2 (IA) não está no escopo desta migration mínima — tabela ai_shadow_suggestions não existe no deploy atual.')
}
