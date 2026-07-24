-- DRE — classificação de contas_financeiras nas seções G/H/I/K
-- Execute este script no Supabase SQL Editor
--
-- Coluna nova, separada de `categoria` (texto livre já usado pela tela de
-- Financeiro) — sem CHECK, mesmo padrão livre. Valores esperados:
-- 'administrativa' | 'pessoal' | 'financeira' | 'retirada' | 'outros'
--
-- Lançamentos existentes ficam com categoria_dre NULL — não há como fazer
-- backfill automático confiável (categoria livre hoje é majoritariamente NULL
-- ou códigos sem relação direta, ex.: "P", "A", "cliente", "fornecedor).

ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS categoria_dre text;

CREATE INDEX IF NOT EXISTS idx_contas_financeiras_categoria_dre ON public.contas_financeiras (categoria_dre);
