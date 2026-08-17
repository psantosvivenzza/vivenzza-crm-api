-- Baseline LOCAL apenas — leads/whatsapp_mensagens já existem em produção
-- (criadas fora de controle de versão), mas não faziam parte do schema local
-- de teste até agora (achado ao corrigir o bug de mistura WhatsApp
-- Financeiro/Comercial, 2026-08-17 — o teste de ACK em
-- webhook-ack-integration.test.mjs já lamentava essa lacuna num comentário).
-- Shape mínimo suficiente pra exercitar processWhatsappEvent()
-- (webhook-handler.js) de verdade contra Postgres local.
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text,
  telefone text,
  etapa text NOT NULL DEFAULT 'novo',
  origem text CHECK (origem IN ('whatsapp', 'instagram', 'site', 'manual')),
  campanha_origem text,
  ctwa_clid text,
  responsavel_id uuid REFERENCES public.usuarios(id),
  cliente_erp_id text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.whatsapp_mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  mensagem text,
  direcao text,
  telefone text,
  status text,
  evolution_id text UNIQUE,
  media_tipo text,
  media_data jsonb,
  media_url text,
  -- já nasce com a coluna (migration 20260101000041 aplica só em produção,
  -- onde a tabela já existia sem ela — aqui é no-op via IF EXISTS/IF NOT EXISTS).
  instance_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
