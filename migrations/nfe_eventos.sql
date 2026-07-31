-- Log de auditoria append-only de eventos fiscais (emissão, autorização,
-- rejeição, cancelamento, CC-e, inutilização, consulta, reconciliação,
-- estorno de comissão). Complementa nfe.motivo_rejeicao/xml_cancelamento, que
-- só guardam o ÚLTIMO estado — aqui fica CADA evento, na ordem em que aconteceu.
CREATE TABLE public.nfe_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nfe_id uuid NOT NULL REFERENCES public.nfe(id) ON DELETE CASCADE,
  tipo_evento text NOT NULL CHECK (tipo_evento IN (
    'criacao', 'validacao', 'envio', 'autorizacao', 'rejeicao', 'denegacao',
    'cancelamento', 'carta_correcao', 'inutilizacao', 'consulta',
    'reconciliacao', 'erro_comunicacao', 'estorno_comissao'
  )),
  status_anterior text,
  status_novo text,
  cstat text,
  xmotivo text,
  protocolo text,
  correlation_id uuid,
  usuario_id uuid REFERENCES public.usuarios(id),
  motivo text,
  ip text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON public.nfe_eventos (nfe_id, criado_em DESC);
CREATE INDEX ON public.nfe_eventos (correlation_id);

-- Trava de append-only real (não só convenção de código) — impede update/delete
-- mesmo por acesso direto via SQL Editor ou bug futuro na aplicação.
REVOKE UPDATE, DELETE ON public.nfe_eventos FROM anon, authenticated, service_role;
