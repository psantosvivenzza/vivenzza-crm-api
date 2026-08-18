-- BASELINE LOCAL — NÃO É MIGRATION DE PRODUÇÃO. Nunca aplicar em produção.
-- 003_collection: tabelas FASE B.1 (score/NBA/promessas/timeline/DNC) que já
-- existem em produção sob uma migration real não espelhada em arquivo git
-- (ver FASE INFRA-MIGRATION-AUDIT) + negotiation_policies/ai_tool_audit +
-- evolution_health (idem) + as feature flags collection_v2_* que NUNCA
-- chegaram a produção (só existem localmente, sempre default false/NULL —
-- fail closed, motor v2 nasce dormente).

CREATE TABLE IF NOT EXISTS public.collection_recovery_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  score integer NOT NULL,
  formula_version text NOT NULL,
  componentes jsonb NOT NULL,
  explicacao text NOT NULL,
  calculado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.collection_priority_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  score integer NOT NULL,
  formula_version text NOT NULL,
  componentes jsonb NOT NULL,
  explicacao text NOT NULL,
  calculado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.nba_shadow_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  nba_suggested_action text NOT NULL,
  nba_reason_codes jsonb,
  legacy_action text,
  recovery_score integer,
  priority_score integer,
  criado_em timestamptz NOT NULL DEFAULT now(),
  effective_legacy_action text,
  blocked_reason text
);

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

CREATE TABLE IF NOT EXISTS public.collection_timeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  cliente_telefone text,
  tipo text NOT NULL,
  origem text NOT NULL,
  canal text,
  descricao text NOT NULL,
  dados jsonb,
  criado_por uuid REFERENCES public.usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.collection_do_not_contact (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_telefone text NOT NULL,
  motivo text,
  canal text NOT NULL CHECK (canal IN ('todos', 'whatsapp', 'ligacao')),
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  registrado_por uuid REFERENCES public.usuarios(id),
  expira_em timestamptz
);

CREATE TABLE IF NOT EXISTS public.evolution_health (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  verificado_em timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL,
  latencia_ms integer,
  detalhes jsonb,
  alerta_enviado boolean NOT NULL DEFAULT false
);

-- Políticas de negociação administráveis — nasce VAZIA de propósito: sem
-- política cadastrada pra uma situação, a IA sempre escala pra humano.
CREATE TABLE IF NOT EXISTS public.negotiation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  parcelas_min integer NOT NULL DEFAULT 1,
  parcelas_max integer,
  desconto_maximo_percentual numeric(5, 2) NOT NULL DEFAULT 0,
  entrada_minima_percentual numeric(5, 2),
  exige_aprovacao_humana boolean NOT NULL DEFAULT true,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid REFERENCES public.usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_tool_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id text NOT NULL,
  contas_financeiras_id uuid REFERENCES public.contas_financeiras(id),
  ferramenta text NOT NULL,
  parametros jsonb NOT NULL,
  autorizado boolean NOT NULL,
  motivo_negado text,
  resultado_resumo text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Feature flags do motor v2 que nunca chegaram a produção — todas opt-in
-- (default false/NULL), mesmo padrão de automacoes_config.cobranca_whatsapp_ativa.
ALTER TABLE public.automacoes_config
  ADD COLUMN IF NOT EXISTS collection_engine_v2 boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_whatsapp boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_knowledge boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS recovery_score boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS priority_score boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS next_best_action boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_voice_calls boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_call_alerts boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ml_recovery_score boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS collection_v2_pilot_percent integer NULL,
  ADD COLUMN IF NOT EXISTS collection_v2_pilot_client_ids jsonb NULL;

ALTER TABLE public.automacoes_config
  DROP CONSTRAINT IF EXISTS automacoes_config_pilot_percent_range;
ALTER TABLE public.automacoes_config
  ADD CONSTRAINT automacoes_config_pilot_percent_range
  CHECK (collection_v2_pilot_percent IS NULL OR collection_v2_pilot_percent BETWEEN 0 AND 100);
