-- Pedidos — índices de performance (achados ao investigar timeout em produção)
-- Execute este script no Supabase SQL Editor
--
-- pedido_itens.pedido_id não tinha índice: qualquer join/agregação por pedido
-- (usado em GET /api/pedidos) forçava sequential scan nas 55k+ linhas da tabela
-- a cada pedido da página. pedidos.criado_em (usada no ORDER BY da listagem)
-- também não tinha índice. Pré-existente — não foi introduzido pelas mudanças
-- de campos do pedido, só ficou visível ao testar as rotas depois delas.

CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido_id ON public.pedido_itens (pedido_id);
CREATE INDEX IF NOT EXISTS idx_pedidos_criado_em ON public.pedidos (criado_em DESC);
