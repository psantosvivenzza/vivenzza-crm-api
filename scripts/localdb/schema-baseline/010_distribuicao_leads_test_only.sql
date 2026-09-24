-- Baseline LOCAL apenas — distribuicao_leads já existe em produção (criada
-- fora de controle de versão, mesma situação de leads/whatsapp_mensagens em
-- 004_crm_whatsapp.sql), mas nunca fez parte do schema local de teste.
-- Shape mínimo pra proximo_vendedor_atomic() (supabase/migrations/
-- 20260101000031_usuarios_recebe_leads.sql) e criar_lead_whatsapp_atomic()
-- (supabase/migrations/20260101000074_criar_lead_whatsapp_atomic.sql)
-- rodarem de verdade contra Postgres local — sem isso, qualquer teste que
-- crie um lead novo via webhook-handler.js falha com "relation
-- distribuicao_leads does not exist" (achado ao escrever o teste de
-- concorrência do bug de leads órfãos/duplicados, 2026-09-24).
CREATE TABLE IF NOT EXISTS public.distribuicao_leads (
  id integer PRIMARY KEY,
  ultimo_vendedor_id uuid REFERENCES public.usuarios(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.distribuicao_leads (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
