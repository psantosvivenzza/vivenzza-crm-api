-- IA WhatsApp MVP — fila de jobs para o worker local (Ollama roda na máquina
-- do desenvolvedor, não no Railway). O backend prepara TUDO (prompt de
-- classificação + prompt de geração, já com contexto embutido); o worker só
-- executa inferência e devolve o texto bruto do modelo — nunca decide nada,
-- nunca recebe acesso a mais dados do que esta mensagem específica.
CREATE TABLE IF NOT EXISTS public.ai_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid REFERENCES public.contas_financeiras(id),
  cliente_telefone text NOT NULL,
  mensagem_cliente text NOT NULL,
  classify_system_prompt text NOT NULL,
  generate_system_prompt text NOT NULL,
  status text NOT NULL DEFAULT 'pending', -- pending | leased | done | failed
  leased_at timestamptz,
  lease_expires_at timestamptz,
  raw_classify_response text,
  raw_generate_response text,
  suggestion_id uuid REFERENCES public.ai_shadow_suggestions(id),
  erro text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_status ON public.ai_jobs (status, criado_em);

-- Contrato de feedback supervisionado (item 13 do pedido) — SEM fine-tuning
-- automático nesta rodada. Só prepara onde o operador registra
-- aprovar/editar/descartar; quando editado, guarda o texto final ao lado do
-- original sugerido — matéria-prima para um aprendizado futuro, não usado
-- automaticamente por nada ainda.
ALTER TABLE public.ai_shadow_suggestions
  ADD COLUMN IF NOT EXISTS feedback_status text NOT NULL DEFAULT 'pending', -- pending | approved | edited | discarded
  ADD COLUMN IF NOT EXISTS final_reply_operator text,
  ADD COLUMN IF NOT EXISTS feedback_by uuid REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_ai_shadow_suggestions_feedback_status ON public.ai_shadow_suggestions (feedback_status);
