-- Vínculo automático leads ↔ clientes_erp por telefone
-- Execute este script no Supabase SQL Editor
--
-- Guarda o legacy_id (texto) do cliente_erp vinculado — diferente do padrão usado em
-- pedidos.cliente_erp_id (que é uuid → clientes_erp.id). Decisão explícita: aqui o
-- vínculo é pelo código do cliente no legado, não pelo uuid interno.

ALTER TABLE public.leads
  ADD COLUMN cliente_erp_id text REFERENCES public.clientes_erp(legacy_id);

CREATE INDEX IF NOT EXISTS idx_leads_cliente_erp_id ON public.leads (cliente_erp_id);
