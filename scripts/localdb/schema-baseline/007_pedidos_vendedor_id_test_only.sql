-- BASELINE LOCAL TEST-ONLY — NÃO É MIGRATION DE PRODUÇÃO.
--
-- `pedidos`, `produtos`, `pedido_itens` e `pedido_historico` existem em
-- produção (criadas manualmente, nunca tiveram migration git-versionada —
-- mesmo padrão de gap já documentado para `avaliacoes_loja` antes da
-- PR #89 e para `leads`/`contas_financeiras` neste mesmo baseline). Sem
-- acesso de introspecção à produção nesta sessão, as colunas abaixo foram
-- reconstruídas SOMENTE a partir da leitura integral de src/routes/pedidos.js,
-- src/routes/produtos.js e src/lib/comissoes.js (2026-09-13) — cobre
-- exatamente o que esse código lê/escreve, não pretende ser 100% fiel ao
-- schema real de produção (pode faltar coluna/constraint que produção tem e
-- este código não toca). Objetivo único: reproduzir e corrigir, em ambiente
-- sintético isolado, o achado de mass assignment de `vendedor_id` em
-- POST /api/pedidos (auditoria 2026-09-13).
--
-- Nunca aplicar em produção. Nunca popular com dado real.

CREATE TABLE IF NOT EXISTS public.produtos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  sku text,
  descricao text,
  linha_id uuid,
  preco_b2c numeric,
  preco_b2b numeric,
  preco_distribuidor numeric,
  extra_precos jsonb DEFAULT '{}'::jsonb,
  ativo boolean DEFAULT true,
  criado_em timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_erp_id uuid REFERENCES public.clientes_erp(id),
  lead_id uuid,
  usuario_id uuid REFERENCES public.usuarios(id),
  total numeric,
  desconto numeric DEFAULT 0,
  observacoes text,
  status text DEFAULT 'rascunho',
  status_fiscal text,
  condicao_pagamento text,
  forma_pagamento text,
  lista_preco text,
  vendedor_id uuid REFERENCES public.usuarios(id),
  vendedor_nome text,
  valor_frete numeric DEFAULT 0,
  tipo_frete text,
  peso_bruto numeric,
  peso_liquido numeric,
  qtde_volumes numeric,
  sistema_origem text DEFAULT 'manual',
  valor_base_comissao numeric,
  comissao_percentual_snapshot numeric,
  campos_com_override_local jsonb,
  atualizado_localmente_em timestamptz,
  atualizado_localmente_por_usuario_id uuid,
  conflito_sincronizacao boolean DEFAULT false,
  erro_sincronizacao text,
  precisa_vinculo_cliente boolean DEFAULT false,
  sincronizado_em timestamptz,
  criado_em timestamptz DEFAULT now(),
  atualizado_em timestamptz
);

CREATE TABLE IF NOT EXISTS public.pedido_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid REFERENCES public.pedidos(id),
  produto_id uuid REFERENCES public.produtos(id),
  quantidade numeric NOT NULL,
  preco_unitario numeric NOT NULL
);

CREATE TABLE IF NOT EXISTS public.pedido_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid REFERENCES public.pedidos(id),
  campo text,
  valor_anterior text,
  valor_novo text,
  usuario_id uuid,
  origem text,
  criado_em timestamptz DEFAULT now()
);
