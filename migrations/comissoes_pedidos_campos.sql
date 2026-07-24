-- Comissões — renomeia representante_* para vendedor_* em pedidos e adiciona
-- campos de status fiscal / snapshot de comissão. Execute no Supabase SQL Editor
-- (já aplicado via MCP em 2026-07-23).
--
-- ATENÇÃO: o rename de coluna NÃO renomeia a FK constraint gerada pelo Postgres.
-- Confirmado via pg_constraint: a constraint continua se chamando
-- `pedidos_representante_id_fkey`, mesmo apontando pra vendedor_id agora.
-- Usar esse nome exato em qualquer embed supabase-js (`usuarios!pedidos_representante_id_fkey`).

ALTER TABLE public.pedidos RENAME COLUMN representante_id TO vendedor_id;
ALTER TABLE public.pedidos RENAME COLUMN representante_nome TO vendedor_nome;
ALTER TABLE public.pedidos RENAME COLUMN comissao_percentual TO comissao_percentual_snapshot;
ALTER TABLE public.pedidos
  ADD COLUMN valor_base_comissao numeric(15,2),
  ADD COLUMN status_fiscal varchar(30) NOT NULL DEFAULT 'nao_faturado'
    CHECK (status_fiscal IN ('nao_faturado','processando','autorizado','rejeitado','cancelado')),
  ADD COLUMN numero_nfe varchar(20);
CREATE INDEX idx_pedidos_status_fiscal ON public.pedidos (status_fiscal);
CREATE INDEX idx_pedidos_vendedor_id ON public.pedidos (vendedor_id);
