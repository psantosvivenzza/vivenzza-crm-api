-- Hard cap de gasto diário do Meta Ads da Vivenzza. Mesmo padrão de kill-switch
-- de collection_v2_feature_flags.sql: automação nova que mexe com dinheiro real
-- nunca liga sozinha — meta_budget_guard_enabled e meta_budget_guard_dry_run
-- começam desligada/em simulação até alguém ligar explicitamente.
--
-- meta_budget_guard_enabled=false  -> job só loga o que faria, não chama a Graph API de escrita nem manda WhatsApp.
-- meta_budget_guard_enabled=true, meta_budget_guard_dry_run=true  -> mesma coisa (simula, loga, mas não executa nada real).
-- meta_budget_guard_enabled=true, meta_budget_guard_dry_run=false -> modo real: pausa/reativa campanhas e manda WhatsApp de verdade.
-- (dry_run só importa quando enabled=true; deixamos os dois por clareza operacional, não por necessidade lógica.)
-- Thresholds iniciais conservadores (2026-08-12): buffer de R$5 entre alerta e
-- proteção (R$130/R$145) foi considerado insuficiente dado cron de 5min + atraso
-- da Insights API + entrega residual do Meta. Início com R$115/R$125 — dá pra
-- subir depois via UPDATE direto, sem deploy, uma vez que o comportamento em
-- produção for validado.
ALTER TABLE public.automacoes_config
  ADD COLUMN IF NOT EXISTS meta_budget_guard_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS meta_budget_guard_dry_run boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS meta_budget_guard_alert_threshold numeric NOT NULL DEFAULT 115,
  ADD COLUMN IF NOT EXISTS meta_budget_guard_protect_threshold numeric NOT NULL DEFAULT 125,
  ADD COLUMN IF NOT EXISTS meta_budget_guard_hard_cap numeric NOT NULL DEFAULT 150;

-- Log mínimo de ações do guard — também serve de mecanismo de idempotência (via
-- os índices únicos abaixo) e de fonte de verdade pra decidir o que reativar no
-- dia seguinte. Mesmo espírito de integration_events (grava ANTES/DEPOIS de agir,
-- índice único evita repetir a mesma ação).
CREATE TABLE IF NOT EXISTS public.meta_budget_guard_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'campaign', 'adset')),
  action text NOT NULL CHECK (action IN ('alerted', 'paused', 'resumed', 'write_failed', 'manual_override')),
  status_before_guard text,
  spend_at_action numeric,
  reason text NOT NULL,
  dia_conta date NOT NULL,
  pause_action_id uuid REFERENCES public.meta_budget_guard_log(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotência: no máximo 1 alerta e 1 pausa por (entidade, dia da conta) — rodar
-- o cron várias vezes no mesmo dia não repete a ação.
CREATE UNIQUE INDEX IF NOT EXISTS meta_budget_guard_log_daily_idem
  ON public.meta_budget_guard_log (entity_id, entity_type, action, dia_conta)
  WHERE action IN ('alerted', 'paused');

-- Idempotência: cada pausa do guard só pode gerar 1 desfecho (reativação real OU
-- detecção de override manual — os dois "resolvem" a pausa, só um dos dois pode
-- acontecer).
CREATE UNIQUE INDEX IF NOT EXISTS meta_budget_guard_log_resume_idem
  ON public.meta_budget_guard_log (pause_action_id)
  WHERE action IN ('resumed', 'manual_override');

CREATE INDEX IF NOT EXISTS meta_budget_guard_log_dia_conta_idx
  ON public.meta_budget_guard_log (dia_conta);

COMMENT ON TABLE public.meta_budget_guard_log IS
  'Log de ações do hard-cap de spend do Meta Ads (alerta/pausa/reativação/falha de escrita). pause_action_id liga uma reativação à pausa que ela desfaz — resume só acontece para entidades que o próprio guard pausou (nunca reativa algo pausado manualmente, porque nunca teria uma linha "paused" correspondente).';
