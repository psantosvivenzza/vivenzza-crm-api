-- FASE C.3A.1 (homologação, 2026-08-12) — suporte a dispatch TÉCNICO
-- (INTERNAL_TEST) sem poluir contas_financeiras com título fake. Aditiva,
-- não destrutiva, preserva integridade referencial total para cobrança real.
--
-- Decisão explícita do usuário: NÃO criar registro sintético em
-- contas_financeiras. Em vez disso, contas_financeiras_id passa a aceitar
-- NULL, mas só quando purpose='internal_test' — uma CHECK constraint no
-- banco garante isso, não é só convenção de aplicação.

ALTER TABLE public.collection_dispatches
  ALTER COLUMN contas_financeiras_id DROP NOT NULL,
  ALTER COLUMN etapa DROP NOT NULL;

ALTER TABLE public.collection_dispatches
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'collection' CHECK (purpose IN ('collection', 'internal_test'));

-- A regra pedida: purpose != 'internal_test' SEMPRE exige contas_financeiras_id
-- (cobrança real nunca fica órfã de título); purpose='internal_test' PODE ter
-- contas_financeiras_id NULL (não É obrigado a ser null, só permitido).
ALTER TABLE public.collection_dispatches
  ADD CONSTRAINT collection_dispatches_purpose_conta_check
  CHECK (purpose = 'internal_test' OR contas_financeiras_id IS NOT NULL);

COMMENT ON COLUMN public.collection_dispatches.purpose IS
  'collection = cobrança real, sempre ligada a um título (contas_financeiras_id NOT NULL). internal_test = dispatch técnico de homologação, nunca ligado a título real, só criado por harness administrativo explícito (nunca por cron/régua/NBA/score).';
