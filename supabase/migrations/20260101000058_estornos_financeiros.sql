-- GAP DE VERSIONAMENTO — estornos_financeiros nunca teve migration em
-- supabase/migrations/. Existia só em migrations/estornos_financeiros.sql
-- (pasta solta, fora do pipeline real: scripts/localdb-reset.mjs só aplica
-- scripts/localdb/schema-baseline/ + supabase/migrations/, nunca migrations/)
-- e, segundo auditoria anterior (NETVISION_RETIREMENT_READINESS.md), a tabela
-- já existe live em produção — criada manualmente em algum momento, não
-- auditável via git log/git blame. Mesmo padrão de drift documentado em
-- 20260101000034/20260101000045 para outros objetos financeiros, e citado
-- explicitamente como pendente na PR #77 ("fn_baixar_titulo, fn_estornar_baixa,
-- fn_aprovar_estorno, fn_rejeitar_estorno e estornos_financeiros têm o mesmo
-- problema de versionamento ausente ... não tratado aqui").
--
-- Corpo abaixo é o mesmo texto de migrations/estornos_financeiros.sql, SEM
-- nenhuma linha de definição alterada — só IF NOT EXISTS (tabela) e nomes
-- explícitos + IF NOT EXISTS (índices, pra poder ser idempotente; os nomes
-- usados são exatamente os que o Postgres teria gerado sozinho pra
-- `CREATE INDEX ON tabela (coluna)`, então aplicar isto contra a produção
-- real — que já tem a tabela — é no-op seguro, nunca duplica índice).
--
-- Verificação pendente (não executada aqui — sem acesso a produção real):
-- ver query read-only reportada à supervisão em
-- docs/claude-context/verificacao-producao-estornos-baixar-titulo.md pra
-- confirmar que este DDL bate com o schema live antes de aplicar em produção.

-- Evento de estorno de uma baixa financeira — nunca apaga/sobrescreve a baixa
-- original (baixas_financeiras.status vira 'estornada', a linha continua lá).
CREATE TABLE IF NOT EXISTS public.estornos_financeiros (
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

CREATE INDEX IF NOT EXISTS estornos_financeiros_baixa_financeira_id_idx ON public.estornos_financeiros (baixa_financeira_id);
CREATE INDEX IF NOT EXISTS estornos_financeiros_conta_financeira_id_idx ON public.estornos_financeiros (conta_financeira_id);
CREATE INDEX IF NOT EXISTS estornos_financeiros_status_idx ON public.estornos_financeiros (status);

-- No máx. 1 solicitação pendente por baixa — segunda camada de proteção contra
-- concorrência (clique duplo, duas abas), além do lock de linha (SELECT ...
-- FOR UPDATE) dentro das RPCs.
CREATE UNIQUE INDEX IF NOT EXISTS ux_estorno_pendente_por_baixa
  ON public.estornos_financeiros (baixa_financeira_id)
  WHERE status = 'pendente_aprovacao';
