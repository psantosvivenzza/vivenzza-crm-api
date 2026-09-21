-- 2026-09-21 — mesma categoria de gap já documentada em
-- 005_sdr_conversas_test_only.sql/006_leads_atendimento_humano_test_only.sql:
-- leads.status_reativacao/qtd_followups_automaticos/etc. e as tabelas
-- reativacao_fila/reativacao_metricas existem em produção (src/routes/
-- reativacao.js as usa há semanas, desde o incidente de 2026-08-04 citado no
-- próprio arquivo) mas nunca tiveram migration git-versionada. Diferente de
-- 005 (que teve introspecção read-only do OpenAPI do PostgREST), aqui NÃO há
-- acesso à produção nesta sessão — o shape abaixo é derivado SOMENTE das
-- colunas/tabelas que o código real de src/routes/reativacao.js de fato lê e
-- grava (nenhum campo especulativo). Nunca aplicado em produção — só
-- ambiente sintético local exclusivo, suficiente pra exercitar
-- enviarMensagemReativacao() de verdade contra Postgres local.
ALTER TABLE IF EXISTS public.leads
  ADD COLUMN IF NOT EXISTS tipo text,
  ADD COLUMN IF NOT EXISTS ultima_mensagem_em timestamptz,
  ADD COLUMN IF NOT EXISTS ultimo_followup_automatico timestamptz,
  ADD COLUMN IF NOT EXISTS qtd_followups_automaticos integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status_reativacao text,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_out boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_out_em timestamptz,
  ADD COLUMN IF NOT EXISTS whatsapp_opt_out_motivo text;

CREATE TABLE IF NOT EXISTS public.reativacao_fila (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  telefone text,
  tentativa integer,
  status text,
  mensagem_enviada text,
  enviado_em timestamptz,
  respondeu_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.reativacao_metricas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  data date NOT NULL,
  elegiveis integer DEFAULT 0,
  enviados integer DEFAULT 0,
  responderam integer DEFAULT 0,
  passados_vendedor integer DEFAULT 0,
  opt_out integer DEFAULT 0,
  reativados integer DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now()
);
