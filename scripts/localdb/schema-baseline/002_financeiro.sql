-- BASELINE LOCAL — NÃO É MIGRATION DE PRODUÇÃO. Nunca aplicar em produção.
-- 002_financeiro: contas_financeiras (escopo mínimo, sem colunas/FKs de
-- NFe/pedido/fornecedor — fora do escopo da suíte de cobrança), baixas
-- financeiras, cobrancas_whatsapp (canal legado).

CREATE TABLE IF NOT EXISTS public.contas_financeiras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo character varying(10) NOT NULL CHECK (tipo IN ('pagar', 'receber')),
  descricao character varying(255) NOT NULL DEFAULT '',
  valor numeric NOT NULL,
  vencimento date NOT NULL,
  data_pagamento date,
  status character varying(20) NOT NULL DEFAULT 'aberta'
    CHECK (status IN ('aberta', 'vencida', 'paga', 'cancelada', 'pago_parcial')),
  categoria character varying(100),
  pessoa_nome character varying(255),
  documento_ref character varying(100),
  observacoes text,
  -- pedido_id/fornecedor_id/nfe_entrada_id: NULL sempre nesta suíte, sem FK
  -- pra fornecedores/nfe_entradas/pedidos — fora do escopo do motor de
  -- cobrança, não recriamos o ERP inteiro localmente.
  pedido_id uuid,
  fornecedor_id uuid,
  nfe_entrada_id uuid,
  usuario_id uuid REFERENCES public.usuarios(id),
  vendedor_id uuid REFERENCES public.usuarios(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  em_revisao boolean NOT NULL DEFAULT false,
  legacy_id text,
  categoria_dre text,
  telefone_cobranca text,
  valor_pago numeric NOT NULL DEFAULT 0,
  codigo_cliente text,
  em_revisao_financeira boolean NOT NULL DEFAULT false,
  forma_pagamento text,
  observacao_pagamento text,
  numero_parcela integer,
  linha_digitavel text,
  codigo_barras text,
  pix_copia_cola text,
  boleto_pdf_url text,
  status_boleto text DEFAULT 'aguardando',
  origem_lancamento text DEFAULT 'manual'
);

CREATE TABLE IF NOT EXISTS public.baixas_financeiras (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conta_financeira_id uuid NOT NULL REFERENCES public.contas_financeiras(id),
  valor_baixado numeric NOT NULL,
  data_pagamento date NOT NULL,
  forma_pagamento text,
  conta_bancaria_id uuid,
  observacao text,
  origem text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'ativa',
  conciliado boolean NOT NULL DEFAULT false,
  criado_por_usuario_id uuid REFERENCES public.usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  estornado_em timestamptz,
  estornado_por_usuario_id uuid REFERENCES public.usuarios(id),
  motivo_estorno_categoria text,
  motivo_estorno_detalhado text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cobrancas_whatsapp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid REFERENCES public.contas_financeiras(id),
  cliente_nome text NOT NULL,
  cliente_telefone text NOT NULL,
  valor numeric NOT NULL,
  vencimento date,
  dias_atraso integer,
  etapa integer NOT NULL CHECK (etapa BETWEEN 1 AND 8),
  status text NOT NULL DEFAULT 'enviada' CHECK (status IN ('pendente', 'enviada', 'respondida', 'paga')),
  origem text NOT NULL CHECK (origem IN ('cron', 'manual')),
  data_envio timestamptz,
  data_resposta timestamptz,
  mensagem_enviada text,
  created_at timestamptz NOT NULL DEFAULT now()
);
