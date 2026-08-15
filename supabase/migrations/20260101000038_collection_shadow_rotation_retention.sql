-- Hardening do collection shadow (score/NBA) antes da primeira ativação real
-- de score_shadow_mode/nba_shadow_mode — achados de 2026-08-15:
--   - getEligibleAccounts ordenava por id ASC LIMIT 50 sem cursor: sempre as
--     MESMAS ~50 contas de menor UUID, nunca cobria o resto da carteira real
--     (1.161 títulos em aberto em produção).
--   - collection_recovery_scores/collection_priority_scores faziam INSERT
--     puro a cada ciclo — mesma conta processada de novo vira linha nova
--     pra sempre, crescimento sem limite pros mesmos títulos.

-- ── Rotação: cursor persistido, determinístico, auditável ──────────────────
-- Singleton (id sempre 1, mesmo padrão de automacoes_config). NULL = começa
-- do início da carteira ordenada por id. getEligibleAccountsRotativo() lê,
-- persistCursor() (shadowWriteRepository.js) escreve — nunca a mesma função.
CREATE TABLE IF NOT EXISTS public.collection_shadow_cursor (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ultimo_id_processado uuid,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.collection_shadow_cursor (id, ultimo_id_processado)
VALUES (1, NULL) ON CONFLICT (id) DO NOTHING;

-- ── Score "atual": upsert por conta, não histórico por ciclo ───────────────
-- Dedup defensivo antes do índice único (produção está vazia hoje — nunca
-- houve ativação real —, mas isso protege qualquer ambiente com dado de
-- teste/homologação residual). Mantém a linha mais recente por conta;
-- empate exato de timestamp desempata pelo id maior (mais recente de fato).
DELETE FROM public.collection_recovery_scores a USING public.collection_recovery_scores b
  WHERE a.contas_financeiras_id = b.contas_financeiras_id AND a.calculado_em < b.calculado_em;
DELETE FROM public.collection_recovery_scores a USING public.collection_recovery_scores b
  WHERE a.contas_financeiras_id = b.contas_financeiras_id AND a.calculado_em = b.calculado_em AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_recovery_scores_conta_unica
  ON public.collection_recovery_scores (contas_financeiras_id);

DELETE FROM public.collection_priority_scores a USING public.collection_priority_scores b
  WHERE a.contas_financeiras_id = b.contas_financeiras_id AND a.calculado_em < b.calculado_em;
DELETE FROM public.collection_priority_scores a USING public.collection_priority_scores b
  WHERE a.contas_financeiras_id = b.contas_financeiras_id AND a.calculado_em = b.calculado_em AND a.id < b.id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_priority_scores_conta_unica
  ON public.collection_priority_scores (contas_financeiras_id);

-- ── Retenção do nba_shadow_log ──────────────────────────────────────────────
-- nba_shadow_log é histórico DE VERDADE (compara "o que o motor novo diria"
-- ao longo do tempo com "o que a régua antiga fez") — upsert destruiria o
-- propósito da tabela. Só ganha uma política de janela de retenção
-- configurável; a limpeza em si (cleanupNbaShadowLog, shadowWriteRepository.js)
-- existe mas NÃO é chamada por nenhum cron nesta migration — precisa de
-- autorização explícita separada pra agendar.
ALTER TABLE public.automacoes_config
  ADD COLUMN IF NOT EXISTS nba_shadow_log_retention_days integer NOT NULL DEFAULT 90;
