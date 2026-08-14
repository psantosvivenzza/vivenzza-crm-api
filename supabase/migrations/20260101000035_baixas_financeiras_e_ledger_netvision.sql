-- Ledger de pagamentos — MVP.
--
-- ACHADO (2026-08-14): `baixas_financeiras` já existe como schema completo
-- em scripts/localdb/schema-baseline/002_financeiro.sql e já é usada de
-- verdade por src/routes/financeiro.js (baixa manual, PATCH
-- /api/financeiro/contas/:id/baixa via RPC fn_baixar_titulo, GET
-- /api/financeiro/contas/:contaId/baixas) — mas a tabela NÃO existe em
-- produção (confirmado: PGRST205), e não existe NENHUMA migration commitada
-- pra ela ou pra fn_baixar_titulo. Ou seja: a funcionalidade de baixa manual
-- está quebrada em produção hoje, silenciosamente, até esta migration ser
-- aplicada. Este achado é reportado à parte — corrigir aqui é só o efeito
-- colateral de precisar da tabela pro ledger; a RPC fn_baixar_titulo (lógica
-- de recálculo de valor_pago/status com FOR UPDATE) NÃO é recriada nesta
-- migration — não faz parte do escopo desta rodada e não deve ser inventada
-- sem ver o código-fonte real dela.
--
-- Reaproveita `baixas_financeiras` como o ledger de pagamentos (em vez de
-- criar uma tabela nova concorrente) — já tem os campos certos: título
-- relacionado, valor, data, forma de pagamento, origem, status, estorno.
-- Adiciona só o necessário pra sync idempotente do NetVision.
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

-- Extensão pro sync NetVision (não faz parte do baseline local original):
-- chave de idempotência externa. NULL pra baixas manuais (não vem do
-- NetVision) — índice único parcial pra não colidir com NULL x NULL.
ALTER TABLE public.baixas_financeiras ADD COLUMN IF NOT EXISTS legacy_evento_id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_baixas_financeiras_legacy_evento_id
  ON public.baixas_financeiras (legacy_evento_id) WHERE legacy_evento_id IS NOT NULL;
