-- Pedidos — vincula pedido ao cadastro do ERP (clientes_erp) em vez de leads (CRM)
-- Execute este script no Supabase SQL Editor
--
-- lead_id não é removida: pedidos históricos (migrados do legado) continuam só
-- com lead_id. Pedidos novos passam a preencher cliente_erp_id.

ALTER TABLE public.pedidos
  ADD COLUMN cliente_erp_id uuid REFERENCES public.clientes_erp(id);

CREATE INDEX IF NOT EXISTS idx_pedidos_cliente_erp_id ON public.pedidos (cliente_erp_id);
