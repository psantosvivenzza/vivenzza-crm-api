-- Baixas parciais do legado (ValorParcialmentePago em CR_Duplicatas) — o valor
-- migrado é sempre o valor cheio do título, sem descontar pagamento parcial já
-- feito antes da carga. Execute este script no Supabase SQL Editor.

ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS valor_pago numeric NOT NULL DEFAULT 0;
