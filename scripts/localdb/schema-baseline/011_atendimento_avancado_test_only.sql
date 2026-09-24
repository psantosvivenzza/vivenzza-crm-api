-- Baseline LOCAL apenas — "Fase 3 do atendimento avançado" (GET
-- /api/dashboard/atendimento, GET /api/whatsapp/status-espera, job
-- src/jobs/monitoramento-resposta.js) depende de get_ultima_mensagem_por_lead,
-- escalation_log e notifications, mas nenhuma das três tem migration
-- git-versionada — como leads/whatsapp_mensagens (ver comentário no topo de
-- 004_crm_whatsapp.sql), foram criadas direto em produção, fora de controle
-- de versão. Sem isto, qualquer teste local que exercite esse caminho
-- quebraria com "relation does not exist" / "function does not exist" antes
-- de rodar uma única asserção.
--
-- get_ultima_mensagem_por_lead: shape inferido do USO real do código
-- (src/routes/dashboard.js, src/routes/whatsapp.js#status-espera,
-- src/jobs/monitoramento-resposta.js) — sempre consumida como
-- `{ lead_id, direcao, created_at }`, sempre a mensagem mais recente por
-- lead. `p_lead_ids IS NULL` devolve todos os leads com mensagem (usado por
-- status-espera quando quem pede é admin sem filtro); com array, restringe
-- aos ids informados.
CREATE OR REPLACE FUNCTION public.get_ultima_mensagem_por_lead(p_lead_ids uuid[])
RETURNS TABLE (lead_id uuid, direcao text, created_at timestamptz) AS $$
  SELECT DISTINCT ON (wm.lead_id) wm.lead_id, wm.direcao, wm.created_at
  FROM public.whatsapp_mensagens wm
  WHERE p_lead_ids IS NULL OR wm.lead_id = ANY(p_lead_ids)
  ORDER BY wm.lead_id, wm.created_at DESC;
$$ LANGUAGE sql STABLE;

-- escalation_log: 1 linha por (lead_id, level) enquanto o episódio de espera
-- daquele nível estiver "notificado" — monitoramento-resposta.js faz
-- upsert(onConflict: 'lead_id,level') e delete().in('lead_id', ...).
CREATE TABLE IF NOT EXISTS public.escalation_log (
  lead_id uuid NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
  level integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lead_id, level)
);

-- notifications: colunas confirmadas via uso real em src/routes/notifications.js
-- (GET/PATCH) e no INSERT de monitoramento-resposta.js.
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.usuarios(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  description text,
  conversation_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  message_id uuid,
  escalation_level integer,
  is_read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
