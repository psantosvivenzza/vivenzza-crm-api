-- Pedidos — campos comerciais/logísticos do ERP legado (SIN/NetVision)
-- Execute este script no Supabase SQL Editor

ALTER TABLE public.pedidos
  ADD COLUMN condicao_pagamento text,
  ADD COLUMN forma_pagamento text,
  ADD COLUMN lista_preco text,
  ADD COLUMN representante_id uuid REFERENCES public.usuarios(id),
  ADD COLUMN representante_nome text,
  ADD COLUMN comissao_percentual numeric,
  ADD COLUMN valor_frete numeric DEFAULT 0,
  ADD COLUMN tipo_frete text CHECK (tipo_frete IN ('emitente', 'destinatario', 'terceiros', 'sem_frete')),
  ADD COLUMN peso_bruto numeric,
  ADD COLUMN peso_liquido numeric,
  ADD COLUMN qtde_volumes integer;
