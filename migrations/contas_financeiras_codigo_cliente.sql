-- Código do cliente (clientes_erp.legacy_id, ex: "000357") em contas_financeiras.
-- Não existe FK direta pra clientes_erp nessa tabela (só pessoa_nome livre) —
-- populado via backfill batendo título+sequência contra CR_Duplicatas.CodigoCliente
-- no legado (mesmo padrão já usado pra telefone_cobranca e valor_pago).
-- Execute este script no Supabase SQL Editor.

ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS codigo_cliente text;

CREATE INDEX IF NOT EXISTS idx_contas_financeiras_codigo_cliente ON public.contas_financeiras (codigo_cliente);
