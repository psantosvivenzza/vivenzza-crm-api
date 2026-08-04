-- Vínculo pedido ↔ NF-e Série 1 autorizada + classificação de faturamento, pra
-- o Dashboard (pedidos_mes) conseguir separar venda real de bonificação/Série 99
-- sem precisar reclassificar CFOP toda vez. Fonte única da classificação por CFOP
-- é a própria tabela cfops (cadastro já usado no wizard de emissão) — evita ter
-- uma segunda lista hardcoded no código que possa divergir do cadastro real.
--
-- Não reclassifica histórico: os ~8.699 pedidos já faturados vieram do legado
-- (NetVision) sem CFOP confiável por pedido — ficam com classificacao_faturamento
-- NULL, de propósito. Só pedidos faturados via NF-e emitida pelo próprio sistema
-- daqui pra frente recebem valor nessa coluna.

ALTER TABLE public.cfops
  ADD COLUMN IF NOT EXISTS categoria_faturamento text
    CHECK (categoria_faturamento IN ('venda', 'bonificacao', 'outra_operacao'));

-- Venda de fato (produção própria/terceiros, inclusive com ST, dentro e fora do estado).
UPDATE public.cfops SET categoria_faturamento = 'venda' WHERE codigo IN (
  '5101','5102','5103','5104','5109','5110','5116','5117','5401','5403','5405',
  '6101','6102','6108','6109','6117','6401','6403','6404'
);

-- Bonificação, doação, brinde, amostra grátis — sai sem contraprestação, não é venda.
UPDATE public.cfops SET categoria_faturamento = 'bonificacao' WHERE codigo IN (
  '5910','5911','6910','6911'
);

-- Resto do cadastro atual (transferência, demonstração, conserto, vasilhame,
-- outra saída não especificada) — não é venda nem bonificação, categoria própria.
UPDATE public.cfops SET categoria_faturamento = 'outra_operacao'
  WHERE categoria_faturamento IS NULL;

ALTER TABLE public.cfops ALTER COLUMN categoria_faturamento SET NOT NULL;
-- Sem DEFAULT proposital: um CFOP novo cadastrado sem categoria explícita deve
-- falhar o INSERT (erro claro) em vez de cair silenciosamente em alguma categoria.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS nfe_id uuid REFERENCES public.nfe(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS classificacao_faturamento text
    CHECK (classificacao_faturamento IN ('venda', 'bonificacao', 'outra_operacao', 'nao_fiscal'));

CREATE INDEX IF NOT EXISTS idx_pedidos_classificacao_faturamento
  ON public.pedidos (classificacao_faturamento) WHERE classificacao_faturamento IS NOT NULL;
