-- FASE B.5 (homologação, 2026-08-11) — threshold de priority_score usado por
-- nextBestAction.js para RECOMENDAR (não executar) HUMAN_CALL. Aditiva,
-- default seguro calibrado com a carteira elegível completa real (1.108
-- contas, priority máximo real observado = 69 — o valor antigo, 80
-- hardcoded no código, nunca era atingido). O código já funciona com esse
-- default via featureFlags.js mesmo SEM esta coluna existir (select('*') +
-- merge com DEFAULTS) — esta migration só torna o valor configurável em
-- runtime sem precisar de outro deploy. NÃO aplicada em produção nesta fase.
ALTER TABLE public.automacoes_config
  ADD COLUMN IF NOT EXISTS human_call_priority_threshold integer NOT NULL DEFAULT 65;
