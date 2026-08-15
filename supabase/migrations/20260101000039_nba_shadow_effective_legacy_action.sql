-- 2026-08-15 — effective_legacy_action / blocked_reason em nba_shadow_log.
-- legacy_action (existente) é a ação da régua ANTES dos guards reais (só
-- calcularEtapa por dias de atraso). effective_legacy_action é a mesma régua
-- DEPOIS de passar pelos guards reais de elegibilidade (pago/cancelado/
-- em_revisao_financeira/promessa ativa/DNC/fora da régua/sem telefone) — a
-- métrica operacionalmente justa para comparar com nba_suggested_action.
--
-- Nullable, sem default, sem backfill: linhas antigas ficam com os dois
-- campos NULL (nunca calculadas retroativamente) — nenhum histórico é
-- apagado ou reescrito.
ALTER TABLE nba_shadow_log
  ADD COLUMN IF NOT EXISTS effective_legacy_action text NULL,
  ADD COLUMN IF NOT EXISTS blocked_reason text NULL;
