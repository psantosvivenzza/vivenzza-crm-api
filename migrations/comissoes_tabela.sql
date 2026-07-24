-- Comissões — tabela principal, ledger de comissões geradas por NF-e autorizada.
-- Execute no Supabase SQL Editor (já aplicado via MCP em 2026-07-23).

CREATE TABLE public.comissoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL REFERENCES public.pedidos(id),
  nfe_id uuid NOT NULL REFERENCES public.nfe(id),
  vendedor_id uuid NOT NULL REFERENCES public.usuarios(id),
  vendedor_nome_snapshot varchar(255) NOT NULL,
  valor_base numeric(15,2) NOT NULL,
  percentual_snapshot numeric(7,4) NOT NULL,
  valor_comissao numeric(15,2) NOT NULL,
  bateu_meta boolean NOT NULL DEFAULT false,
  meta_mensal_snapshot numeric(15,2),
  total_vendido_no_mes numeric(15,2),
  status varchar(30) NOT NULL DEFAULT 'disponivel'
    CHECK (status IN ('disponivel','paga','estornada','cancelada')),
  data_geracao timestamptz NOT NULL DEFAULT now(),
  data_pagamento timestamptz,
  pago_por_usuario_id uuid REFERENCES public.usuarios(id),
  observacoes text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_comissao_nfe_vendedor ON public.comissoes (nfe_id, vendedor_id);
CREATE INDEX idx_comissoes_vendedor ON public.comissoes (vendedor_id);
CREATE INDEX idx_comissoes_data_geracao ON public.comissoes (data_geracao);
