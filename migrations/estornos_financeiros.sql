-- Evento de estorno de uma baixa financeira — nunca apaga/sobrescreve a baixa
-- original (baixas_financeiras.status vira 'estornada', a linha continua lá).
CREATE TABLE public.estornos_financeiros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  baixa_financeira_id uuid NOT NULL REFERENCES public.baixas_financeiras(id),
  conta_financeira_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  valor_estornado numeric NOT NULL CHECK (valor_estornado > 0),
  motivo_categoria text NOT NULL CHECK (motivo_categoria IN (
    'titulo_errado', 'valor_incorreto', 'pagamento_nao_confirmado', 'baixa_duplicada', 'devolucao_chargeback', 'outro'
  )),
  motivo_detalhado text NOT NULL,
  status text NOT NULL DEFAULT 'pendente_aprovacao' CHECK (status IN ('concluido', 'pendente_aprovacao', 'rejeitado')),
  solicitado_por_usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  aprovado_por_usuario_id uuid REFERENCES public.usuarios(id),
  aprovado_em timestamptz,
  rejeitado_por_usuario_id uuid REFERENCES public.usuarios(id),
  rejeitado_em timestamptz,
  motivo_rejeicao text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.estornos_financeiros (baixa_financeira_id);
CREATE INDEX ON public.estornos_financeiros (conta_financeira_id);
CREATE INDEX ON public.estornos_financeiros (status);

-- No máx. 1 solicitação pendente por baixa — segunda camada de proteção contra
-- concorrência (clique duplo, duas abas), além do lock de linha (SELECT ...
-- FOR UPDATE) dentro das RPCs.
CREATE UNIQUE INDEX ux_estorno_pendente_por_baixa
  ON public.estornos_financeiros (baixa_financeira_id)
  WHERE status = 'pendente_aprovacao';
