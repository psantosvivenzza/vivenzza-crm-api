-- Log de observabilidade da sincronização de pedidos do legado — uma linha por
-- execução (backfill ou incremental), pra saber o que aconteceu sem precisar
-- vasculhar log de aplicação.
CREATE TABLE public.sincronizacoes_pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sistema_origem text NOT NULL CHECK (sistema_origem IN ('legado')),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz,
  status text NOT NULL DEFAULT 'executando'
    CHECK (status IN ('executando', 'concluido', 'concluido_com_erros', 'falhou')),
  cursor_inicial timestamptz,
  cursor_final timestamptz,
  total_lido integer NOT NULL DEFAULT 0,
  total_criado integer NOT NULL DEFAULT 0,
  total_atualizado integer NOT NULL DEFAULT 0,
  total_ignorado integer NOT NULL DEFAULT 0,
  total_com_erro integer NOT NULL DEFAULT 0,
  mensagem_erro text,
  iniciado_por_usuario_id uuid REFERENCES public.usuarios(id)
);

CREATE INDEX ON public.sincronizacoes_pedidos (sistema_origem, iniciado_em DESC);

-- Detalhe de erro por pedido individual — um pedido com problema (ex: cliente
-- ambíguo, item sem produto correspondente) não trava a sincronização inteira;
-- só aquele pedido fica registrado aqui e os outros continuam.
CREATE TABLE public.sincronizacao_pedidos_erros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sincronizacao_id uuid NOT NULL REFERENCES public.sincronizacoes_pedidos(id) ON DELETE CASCADE,
  pedido_externo_id text NOT NULL,
  mensagem text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.sincronizacao_pedidos_erros (sincronizacao_id);
