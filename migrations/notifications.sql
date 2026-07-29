-- Fase 3 do atendimento avançado no WhatsApp: notificações in-app + log de escalonamento
-- do monitoramento de SLA de resposta (15min/30min/2h sem resposta ao cliente).

CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  description text,
  conversation_id uuid REFERENCES public.leads(id),
  message_id uuid REFERENCES public.whatsapp_mensagens(id),
  is_read boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  escalation_level integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON public.notifications (user_id, is_read);
CREATE INDEX ON public.notifications (conversation_id);
CREATE INDEX ON public.notifications (created_at);

-- Garante no banco que cada nível de escalonamento só notifica uma vez por lead POR
-- EPISÓDIO de espera (o job apaga as linhas de um lead quando detecta que ele voltou a
-- ser respondido, liberando o mesmo nível pra disparar de novo na próxima vez que o
-- cliente ficar sem resposta — ver observação no Passo 0).
CREATE TABLE public.escalation_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.leads(id),
  level integer NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(lead_id, level)
);
