-- Suporte a bloqueio TEMPORÁRIO (dia) em collection_do_not_contact, reusando a
-- mesma tabela/guard já homologado do opt-out permanente — ver
-- src/lib/collection/doNotContactGuard.js. NULL preserva 100% do
-- comportamento atual (permanente até remoção manual); não-NULL expira
-- sozinho, sem precisar de remoção manual.
ALTER TABLE IF EXISTS public.collection_do_not_contact
  ADD COLUMN IF NOT EXISTS expira_em timestamptz;
