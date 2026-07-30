-- Garante que reimportar itens de um pedido do legado (ES_ItemPedido) seja
-- idempotente — sem isso, rodar a sincronização duas vezes duplicaria cada
-- item em vez de atualizar o existente. `legacy_id` já existe na tabela
-- (formato previsto: "CodigoFilial-NumeroPedido-Sequencia"); NULLs não colidem
-- entre si no Postgres, então itens criados manualmente pelo CRM (sem
-- legacy_id) não são afetados.
ALTER TABLE public.pedido_itens
  ADD CONSTRAINT pedido_itens_pedido_id_legacy_id_key UNIQUE (pedido_id, legacy_id);
