-- Auditoria de edição de pedido — append-only, nunca apagado nem sobrescrito.
-- Mesmo padrão de `movimentacoes_estoque` (ledger com usuário+motivo+timestamp),
-- já usado no módulo de Estoque. valor_anterior/valor_novo como texto pra
-- cobrir qualquer tipo de campo (numérico, texto, uuid, jsonb) sem precisar de
-- uma coluna polimórfica por tipo.
CREATE TABLE public.pedido_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id uuid NOT NULL REFERENCES public.pedidos(id) ON DELETE CASCADE,
  campo text NOT NULL,
  valor_anterior text,
  valor_novo text,
  usuario_id uuid REFERENCES public.usuarios(id),
  origem text NOT NULL DEFAULT 'local' CHECK (origem IN ('local', 'sincronizacao')),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.pedido_historico (pedido_id, criado_em DESC);
