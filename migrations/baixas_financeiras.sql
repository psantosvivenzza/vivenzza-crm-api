-- Estrutura de baixas financeiras individuais — substitui o modelo anterior de
-- contas_financeiras.valor_pago acumulado sem histórico. A partir de agora
-- baixas_financeiras é a fonte da verdade; valor_pago continua existindo na
-- conta como valor DERIVADO (soma das baixas ativas), mantido por
-- compatibilidade com telas/relatórios que já leem esse campo direto.
CREATE TABLE public.baixas_financeiras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_financeira_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  valor_baixado numeric NOT NULL CHECK (valor_baixado > 0),
  data_pagamento date NOT NULL,
  forma_pagamento text,
  conta_bancaria_id uuid,
  observacao text,
  origem text NOT NULL DEFAULT 'manual'
    CHECK (origem IN ('manual', 'migracao_legado', 'importacao_bancaria', 'pix_automatico')),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'estornada')),
  conciliado boolean NOT NULL DEFAULT false,
  criado_por_usuario_id uuid REFERENCES public.usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  estornado_em timestamptz,
  estornado_por_usuario_id uuid REFERENCES public.usuarios(id),
  motivo_estorno_categoria text,
  motivo_estorno_detalhado text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.baixas_financeiras (conta_financeira_id);
CREATE INDEX ON public.baixas_financeiras (status);

-- Backfill: uma baixa sintética por conta com valor_pago > 0 hoje, representando
-- o histórico acumulado que existia antes desta tabela existir. origem =
-- 'migracao_legado' — o backend só permite estornar essas por inteiro (não há
-- como saber, retroativamente, se aquele total representa 1 ou N pagamentos).
INSERT INTO public.baixas_financeiras
  (conta_financeira_id, valor_baixado, data_pagamento, forma_pagamento, observacao, origem, status, criado_por_usuario_id, criado_em)
SELECT
  id,
  valor_pago,
  COALESCE(data_pagamento, CURRENT_DATE),
  'legado',
  'Saldo migrado do modelo anterior: valor_pago acumulado.',
  'migracao_legado',
  'ativa',
  NULL,
  COALESCE(updated_at, created_at, now())
FROM public.contas_financeiras
WHERE valor_pago > 0;
