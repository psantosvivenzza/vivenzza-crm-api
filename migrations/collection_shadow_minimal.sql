-- FASE B.1 (homologação, 2026-08-11) — SHADOW MÍNIMO. Cria SOMENTE o subconjunto
-- de schema comprovadamente necessário para observar (nunca agir) até
-- shadow_max_customers clientes via Score + Next Best Action, SEM IA/LLM
-- (SHADOW 1 — ver docs/cobranca-ai/MIGRATION_DEPENDENCY_MAP.md para a análise
-- completa, tabela por tabela, do porquê cada uma aqui é necessária e cada uma
-- das outras 13 migrations collection_v2_* é adiável).
--
-- SEGURANÇA DE COMPATIBILIDADE FUTURA: todas as definições de tabela/coluna
-- abaixo são CÓPIAS EXATAS (mesmos nomes, tipos, constraints, índices) das
-- migrations originais (20260101000016, 000019, 000022, 000025, 000027).
-- Quando essas migrations completas forem aplicadas depois (fases futuras),
-- cada CREATE TABLE/ADD COLUMN aqui já existente vira no-op via
-- IF NOT EXISTS/ADD COLUMN IF NOT EXISTS — não há conflito, não há
-- necessidade de renumerar ou alterar as migrations grandes. Esta migration
-- nunca precisa ser revertida quando as outras chegarem; ela só some do
-- "trabalho pendente" porque tudo que ela criou já existe.
--
-- 100% aditivo. Nenhum DROP, nenhum ALTER TYPE, nenhuma reescrita de dado
-- existente. Todas as flags novas nascem OFF/50 (fail closed / amostra
-- pequena) — aplicar esta migration sozinha NÃO muda nenhum comportamento
-- visível para clientes reais.

-- ── automacoes_config: só as 3 colunas que o SHADOW 1 realmente liga ──────
-- (não as 17+ colunas de kill switch de 000014 — featureFlags.js já degrada
-- com segurança para `false` quando a coluna não existe; não a coluna
-- ai_shadow_mode nem collection_v2_pilot_* — fora de escopo do SHADOW 1,
-- ver mapa de dependências).
ALTER TABLE public.automacoes_config
  ADD COLUMN IF NOT EXISTS nba_shadow_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS score_shadow_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_max_customers integer NOT NULL DEFAULT 50;

ALTER TABLE public.automacoes_config
  DROP CONSTRAINT IF EXISTS automacoes_config_shadow_max_customers_positive;
ALTER TABLE public.automacoes_config
  ADD CONSTRAINT automacoes_config_shadow_max_customers_positive
  CHECK (shadow_max_customers > 0);

-- ── collection_timeline_events + collection_promises (cópia de 000016) ────
-- Necessárias porque recoveryScore.js/priorityScore.js LEEM estas tabelas
-- como componentes do cálculo do score (comportamento_promessas,
-- promessa_quebrada, interacao_recente) e nextBestAction.js lê
-- collection_promises para decidir WAIT_PROMISE — não é opcional para SHADOW 1,
-- mesmo sem nenhuma escrita operacional acontecer (ninguém cria promessa real
-- nesta fase; a tabela só precisa existir para ser CONSULTADA, começa vazia).
CREATE TABLE IF NOT EXISTS public.collection_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  cliente_telefone text,
  tipo text NOT NULL,
  origem text NOT NULL CHECK (origem IN ('AUTOMATION', 'AI', 'HUMAN', 'SYSTEM', 'PAYMENT_RECONCILIATION')),
  canal text,
  descricao text NOT NULL,
  dados jsonb,
  criado_por uuid REFERENCES public.usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collection_timeline_conta ON public.collection_timeline_events (contas_financeiras_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_collection_timeline_telefone ON public.collection_timeline_events (cliente_telefone, criado_em DESC);

CREATE TABLE IF NOT EXISTS public.collection_promises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  cliente_nome text NOT NULL,
  cliente_telefone text,
  valor numeric NOT NULL,
  promised_date date NOT NULL,
  origem text NOT NULL CHECK (origem IN ('AUTOMATION', 'AI', 'HUMAN')),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'cumprida', 'quebrada', 'cancelada')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  fulfilled_at timestamptz,
  broken_at timestamptz,
  cancelled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_promises_unica_ativa
  ON public.collection_promises (contas_financeiras_id) WHERE status = 'ativa';
CREATE INDEX IF NOT EXISTS idx_collection_promises_vencendo
  ON public.collection_promises (promised_date) WHERE status = 'ativa';

-- ── collection_do_not_contact (extraída de 000022, sem trazer collection_calls/
-- collection_operators junto — não há FK entre elas, confirmado lendo o arquivo
-- original) — usada por nextBestAction.js (estaEmOptOut).
CREATE TABLE IF NOT EXISTS public.collection_do_not_contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_telefone text NOT NULL,
  motivo text,
  canal text NOT NULL DEFAULT 'todos' CHECK (canal IN ('todos', 'whatsapp', 'ligacao')),
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  registrado_por uuid REFERENCES public.usuarios(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_dnc_telefone_canal ON public.collection_do_not_contact (cliente_telefone, canal);

-- ── collection_recovery_scores + collection_priority_scores (cópia de 000019) ──
CREATE TABLE IF NOT EXISTS public.collection_recovery_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  formula_version text NOT NULL,
  componentes jsonb NOT NULL,
  explicacao text NOT NULL,
  calculado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collection_recovery_scores_conta ON public.collection_recovery_scores (contas_financeiras_id, calculado_em DESC);

CREATE TABLE IF NOT EXISTS public.collection_priority_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  formula_version text NOT NULL,
  componentes jsonb NOT NULL,
  explicacao text NOT NULL,
  calculado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_collection_priority_scores_conta ON public.collection_priority_scores (contas_financeiras_id, calculado_em DESC);
CREATE INDEX IF NOT EXISTS idx_collection_priority_scores_score ON public.collection_priority_scores (score DESC, calculado_em DESC);

-- ── nba_shadow_log (extraída de 000025 — só a metade sem IA) ───────────────
-- ai_shadow_suggestions e a coluna ai_shadow_mode ficam FORA desta migration
-- de propósito (SHADOW 2, fase futura separada).
CREATE TABLE IF NOT EXISTS public.nba_shadow_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  nba_suggested_action text NOT NULL,
  nba_reason_codes jsonb,
  legacy_action text,
  recovery_score integer,
  priority_score integer,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nba_shadow_conta ON public.nba_shadow_log (contas_financeiras_id, criado_em DESC);
