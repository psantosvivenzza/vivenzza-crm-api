-- FASE C.1 (homologação, 2026-08-11) — Central Multi-WhatsApp: infraestrutura
-- + orquestrador. 100% ADITIVA (CREATE TABLE/ADD COLUMN IF NOT EXISTS), sem
-- DROP/TRUNCATE/DELETE/UPDATE, sem FK inventada — NÃO aplicada em produção
-- nesta fase.
--
-- Produção hoje só tem o subconjunto mínimo da FASE B.1 (nba_shadow_log,
-- collection_recovery_scores/priority_scores, collection_promises,
-- collection_do_not_contact, collection_timeline_events) — nenhuma das
-- tabelas abaixo existe lá. Esta migration consolida (mesmo conteúdo já
-- testado localmente, nunca deployado) o que antes eram 3 migrations
-- separadas (integration_events, whatsapp_instances, dispatch engine),
-- porque nenhuma das 3 jamais chegou a produção — aplicar 1 migration nova e
-- coerente é mais simples e seguro que reconstituir uma cadeia de 3.
--
-- O sender legado (src/jobs/cobranca-whatsapp.js, src/lib/evolutionFinanceiro.js)
-- continua 100% intocado e é quem manda hoje — nada aqui migra a régua real
-- pra este orquestrador. Kill switch multi_whatsapp=false por padrão.

-- 1) Idempotência de eventos externos (webhooks Evolution) — pré-requisito do
-- orquestrador para nunca reprocessar o mesmo ACK duas vezes.
CREATE TABLE IF NOT EXISTS public.integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_type text NOT NULL,
  external_id text NOT NULL,
  payload_hash text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processed', 'failed', 'ignored')),
  error text
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_events_dedupe
  ON public.integration_events (provider, event_type, external_id);
CREATE INDEX IF NOT EXISTS idx_integration_events_status ON public.integration_events (processing_status, received_at);

-- 2) Central de instâncias WhatsApp — nenhum segredo armazenado (api_key_env_var
-- guarda só o NOME da env var, nunca o valor). Backfill idempotente registra a
-- instância vivenzza-financeiro que JÁ RODA em produção hoje como 'principal'
-- — não cria/altera/desconecta nada na Evolution real, só o registro no CRM.
CREATE TABLE IF NOT EXISTS public.whatsapp_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  instance_name text NOT NULL UNIQUE,
  priority integer NOT NULL DEFAULT 1,
  role text NOT NULL DEFAULT 'reserva' CHECK (role IN ('principal', 'reserva')),
  enabled boolean NOT NULL DEFAULT true,
  api_base_url text,
  api_key_env_var text NOT NULL DEFAULT 'EVOLUTION_API_KEY',
  connection_status text NOT NULL DEFAULT 'unknown',
  health_status text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('connected', 'disconnected', 'degraded', 'cooldown', 'disabled', 'error', 'unknown')),
  last_connection_update timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  hourly_limit integer,
  daily_limit integer,
  sent_today integer NOT NULL DEFAULT 0,
  delivered_today integer NOT NULL DEFAULT 0,
  failed_today integer NOT NULL DEFAULT 0,
  read_today integer NOT NULL DEFAULT 0,
  responses_today integer NOT NULL DEFAULT 0,
  counters_reset_at date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_priority ON public.whatsapp_instances (enabled, priority);

-- FASE C.2 (homologação) — achado real da revisão: nada impedia 2 instâncias
-- 'principal' habilitadas ao mesmo tempo (ex: cadastro manual futuro por
-- engano). Índice único parcial garante isso NO BANCO, não só por convenção
-- de aplicação — a 2ª tentativa de habilitar um 2º principal falha na
-- constraint, nunca fica em estado ambíguo silenciosamente.
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_instances_unica_principal_ativa
  ON public.whatsapp_instances (role)
  WHERE role = 'principal' AND enabled = true;

INSERT INTO public.whatsapp_instances (name, instance_name, priority, role, enabled)
VALUES ('WhatsApp Financeiro 01', 'vivenzza-financeiro', 1, 'principal', true)
ON CONFLICT (instance_name) DO NOTHING;

-- 3) Motor de tentativas — 1 cobrança lógica (collection_dispatches) tem 1+
-- tentativas (collection_dispatch_attempts), cada uma em uma instância
-- diferente. idempotency_key único por (título, etapa, dia BRT) garante que
-- retry/restart/2 cliques nunca duplicam a cobrança lógica.
CREATE TABLE IF NOT EXISTS public.collection_dispatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  etapa integer NOT NULL,
  canal text NOT NULL DEFAULT 'whatsapp' CHECK (canal IN ('whatsapp', 'ai_whatsapp')),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'expired', 'cancelled')),
  origem text NOT NULL CHECK (origem IN ('cron', 'manual', 'nba')),
  mensagem text NOT NULL,
  cliente_nome text NOT NULL,
  cliente_telefone text NOT NULL,
  valor numeric,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  cancelado_em timestamptz,
  cancelado_motivo text
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_dispatches_idempotency ON public.collection_dispatches (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_collection_dispatches_conta ON public.collection_dispatches (contas_financeiras_id);
CREATE INDEX IF NOT EXISTS idx_collection_dispatches_status ON public.collection_dispatches (status);
CREATE INDEX IF NOT EXISTS idx_collection_dispatches_criado_em ON public.collection_dispatches (criado_em);

-- failure_kind cobre a taxonomia completa de classifyEvolutionFailure()
-- (src/lib/collection/evolutionAdapter.js) — só 'instance_unavailable' e
-- 'instance_disconnected' são failover-eligible; as demais existem pra
-- observabilidade (por que NÃO tentou outra instância), nunca pra decisão.
CREATE TABLE IF NOT EXISTS public.collection_dispatch_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispatch_id uuid NOT NULL REFERENCES public.collection_dispatches(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  whatsapp_instance_id uuid REFERENCES public.whatsapp_instances(id),
  status text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed', 'expired', 'cancelled')),
  failure_kind text CHECK (failure_kind IN (
    'explicit_error', 'instance_disconnected', 'instance_unavailable', 'delivery_timeout',
    'permanent_recipient', 'rate_limit', 'auth', 'platform_restriction', 'unknown'
  )),
  erro text,
  provider_message_id text,
  enviado_em timestamptz,
  entregue_em timestamptz,
  lido_em timestamptz,
  falhou_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dispatch_id, attempt_number)
);
CREATE INDEX IF NOT EXISTS idx_collection_dispatch_attempts_dispatch ON public.collection_dispatch_attempts (dispatch_id);
CREATE INDEX IF NOT EXISTS idx_collection_dispatch_attempts_provider_msg ON public.collection_dispatch_attempts (provider_message_id);
CREATE INDEX IF NOT EXISTS idx_collection_dispatch_attempts_criado_em ON public.collection_dispatch_attempts (criado_em);

-- 4) Kill switch + limites globais/config do orquestrador. Defaults idênticos
-- aos valores hoje HARDCODED e já validados em produção pelo sender legado
-- (45-90s entre envios, 30/dia, 10/hora) — se esta migration for aplicada,
-- o comportamento configurado nasce coerente com o que já roda hoje, não com
-- valores nunca testados. multi_whatsapp=false: o motor novo continua
-- dormente até uma decisão explícita futura de ligar (fase separada).
ALTER TABLE public.automacoes_config
  ADD COLUMN IF NOT EXISTS multi_whatsapp boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_failover boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS min_send_delay_seconds integer NOT NULL DEFAULT 45,
  ADD COLUMN IF NOT EXISTS max_send_delay_seconds integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS global_daily_limit integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS global_hourly_limit integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS delivery_timeout_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS failover_on_delivery_timeout boolean NOT NULL DEFAULT false;

-- Nota: o modo de homologação (allowlist de números de teste) já existe e é
-- 100% controlado por env var server-side (COLLECTION_TEST_MODE +
-- COLLECTION_TEST_PHONE_ALLOWLIST em evolutionAdapter.js) — deliberadamente
-- NÃO duplicado como coluna aqui, pra não criar uma segunda fonte de verdade
-- que poderia divergir do gate real.
