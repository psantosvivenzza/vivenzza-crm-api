-- Snapshot de logística do legado. Somente sincronização explícita preenche;
-- importar para cotação não modifica o pedido comercial.
alter table public.pedidos add column if not exists frete_logistica jsonb;
comment on column public.pedidos.frete_logistica is 'Snapshot NetVision para sugestão de peso/cubagem; unidades e carga embalada exigem conferência humana.';
