-- Fase 2 do atendimento avançado no WhatsApp: reações em mensagens.
-- Uma reação por usuário por mensagem (UNIQUE) — trocar de emoji ou reagir de novo
-- na mesma reação é tratado no backend (update/delete), não precisa de mais de uma
-- linha por par (message_id, user_id).

CREATE TABLE public.message_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES public.whatsapp_mensagens(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(message_id, user_id)
);

CREATE INDEX ON public.message_reactions (message_id);
CREATE INDEX ON public.message_reactions (user_id);
