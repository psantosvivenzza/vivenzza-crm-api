-- Metadados do certificado digital — NUNCA a senha nem o arquivo .pfx (isso
-- continua fora do banco, em NFE_CERT_SENHA/CERT_BASE64). Só o necessário pra
-- alertar vencimento e auditar qual certificado emitiu cada nota.
CREATE TABLE public.certificados_metadados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  titular_cnpj text NOT NULL,
  numero_serie text,
  emissor text,
  valido_de date,
  valido_ate date NOT NULL,
  ambiente text NOT NULL DEFAULT 'homologacao' CHECK (ambiente IN ('homologacao', 'producao')),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.certificados_metadados (valido_ate) WHERE ativo = true;
