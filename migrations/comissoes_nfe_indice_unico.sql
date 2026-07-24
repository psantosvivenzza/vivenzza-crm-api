-- Comissões — trava "1 pedido = 1 NF-e autorizada" no próprio banco.
-- Execute no Supabase SQL Editor (já aplicado via MCP em 2026-07-23).

CREATE UNIQUE INDEX ux_nfe_pedido_autorizada ON public.nfe (pedido_id)
  WHERE status = 'autorizada' AND pedido_id IS NOT NULL;
