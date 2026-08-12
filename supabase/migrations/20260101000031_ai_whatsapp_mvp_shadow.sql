-- IA WhatsApp MVP (2026-08-12) — shadow: a IA classifica intenção e sugere
-- resposta, mas NUNCA envia/decide sozinha. Três tabelas:
--
-- negotiation_policies: nasce VAZIA de propósito. Sem política cadastrada, a
-- IA sempre escala para humano — nunca inventa desconto/parcelamento/condição.
--
-- ai_tool_audit: audita toda consulta de contexto feita pelo motor de IA
-- (autorizada ou negada), por conversa/título.
--
-- ai_shadow_suggestions: a saída estruturada da IA por mensagem recebida —
-- shadow por construção (não referenciada por nenhum fluxo de envio real;
-- nenhuma foreign key aponta PARA cá, só DAQUI para contas_financeiras).
CREATE TABLE IF NOT EXISTS public.negotiation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  parcelas_min integer NOT NULL DEFAULT 1,
  parcelas_max integer,
  desconto_maximo_percentual numeric(5, 2) NOT NULL DEFAULT 0,
  entrada_minima_percentual numeric(5, 2),
  exige_aprovacao_humana boolean NOT NULL DEFAULT true,
  ativo boolean NOT NULL DEFAULT true,
  criado_por uuid REFERENCES public.usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_negotiation_policies_ativo ON public.negotiation_policies (ativo);

CREATE TABLE IF NOT EXISTS public.ai_tool_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid REFERENCES public.contas_financeiras(id),
  ferramenta text NOT NULL,
  parametros jsonb NOT NULL DEFAULT '{}',
  autorizado boolean NOT NULL,
  motivo_negado text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_tool_audit_conta ON public.ai_tool_audit (contas_financeiras_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_ai_tool_audit_negados ON public.ai_tool_audit (autorizado) WHERE autorizado = false;

CREATE TABLE IF NOT EXISTS public.ai_shadow_suggestions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid REFERENCES public.contas_financeiras(id),
  cliente_telefone text NOT NULL,
  mensagem_cliente text NOT NULL,
  intent text NOT NULL,
  confidence text NOT NULL,
  cliente_irritado boolean NOT NULL DEFAULT false,
  suggested_reply text,
  recommended_action text NOT NULL,
  requires_human boolean NOT NULL DEFAULT true,
  reason_codes jsonb NOT NULL DEFAULT '[]',
  extracted_date date,
  promise_candidate jsonb,
  tools_requested jsonb NOT NULL DEFAULT '[]',
  ai_provider text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_shadow_suggestions_conta ON public.ai_shadow_suggestions (contas_financeiras_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_ai_shadow_suggestions_requires_human ON public.ai_shadow_suggestions (requires_human) WHERE requires_human = true;
