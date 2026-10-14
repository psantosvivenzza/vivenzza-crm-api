-- Internal follow-ups only. No outbound message, financial change or campaign activation.
-- Version aligned with the confirmed production migration journal.
ALTER TABLE public.tarefas
  ADD COLUMN IF NOT EXISTS retorno_request_id uuid,
  ADD COLUMN IF NOT EXISTS retorno_criado_por uuid REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS retorno_cancelado_em timestamptz,
  ADD COLUMN IF NOT EXISTS retorno_acao text;
CREATE UNIQUE INDEX IF NOT EXISTS tarefas_retorno_request_unique ON public.tarefas(retorno_request_id);
CREATE UNIQUE INDEX IF NOT EXISTS tarefas_retorno_pendente_lead_unique ON public.tarefas(lead_id)
  WHERE retorno_request_id IS NOT NULL AND status = 'pendente' AND retorno_cancelado_em IS NULL;

CREATE OR REPLACE FUNCTION public.agendar_retorno_whatsapp(
  p_request_id uuid, p_lead_id uuid, p_usuario_id uuid, p_responsavel_id uuid,
  p_prazo timestamptz, p_motivo text, p_acao text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_role text; v_dono uuid; v_tarefa public.tarefas;
BEGIN
  SELECT role INTO v_role FROM usuarios WHERE id = p_usuario_id AND ativo = true;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'vendedor') THEN
    RAISE EXCEPTION 'Acesso negado' USING ERRCODE = '42501';
  END IF;
  SELECT responsavel_id INTO v_dono FROM leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead inexistente' USING ERRCODE = 'P0002'; END IF;
  IF v_role = 'vendedor' AND (v_dono IS DISTINCT FROM p_usuario_id OR p_responsavel_id IS DISTINCT FROM p_usuario_id) THEN
    RAISE EXCEPTION 'Acesso negado à carteira' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM usuarios WHERE id = p_responsavel_id AND ativo = true AND role IN ('admin', 'vendedor')) THEN
    RAISE EXCEPTION 'Responsável indisponível' USING ERRCODE = '22023';
  END IF;
  IF p_request_id IS NULL OR p_motivo IS NULL OR length(trim(p_motivo)) NOT BETWEEN 3 AND 1000
    OR p_acao IS NULL OR p_acao NOT IN ('whatsapp', 'ligacao') THEN
    RAISE EXCEPTION 'Dados de retorno inválidos' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_tarefa FROM tarefas WHERE retorno_request_id = p_request_id;
  IF FOUND THEN
    IF v_tarefa.lead_id IS DISTINCT FROM p_lead_id OR v_tarefa.retorno_criado_por IS DISTINCT FROM p_usuario_id
      OR v_tarefa.responsavel_id IS DISTINCT FROM p_responsavel_id OR v_tarefa.prazo IS DISTINCT FROM p_prazo
      OR v_tarefa.descricao IS DISTINCT FROM trim(p_motivo) OR v_tarefa.retorno_acao IS DISTINCT FROM p_acao THEN
      RAISE EXCEPTION 'Chave de retorno reutilizada' USING ERRCODE = '23505';
    END IF;
    RETURN to_jsonb(v_tarefa);
  END IF;
  IF p_prazo IS NULL OR p_prazo <= now() OR p_prazo > now() + interval '366 days' THEN
    RAISE EXCEPTION 'Prazo inválido' USING ERRCODE = '22023';
  END IF;
  INSERT INTO tarefas(lead_id,titulo,descricao,prazo,tipo,status,responsavel_id,origem,retorno_request_id,retorno_criado_por,retorno_acao)
    VALUES(p_lead_id,'Retorno agendado',trim(p_motivo),p_prazo,'outro','pendente',p_responsavel_id,'manual',p_request_id,p_usuario_id,p_acao)
    RETURNING * INTO v_tarefa;
  RETURN to_jsonb(v_tarefa);
END;
$$;
REVOKE ALL ON FUNCTION public.agendar_retorno_whatsapp(uuid,uuid,uuid,uuid,timestamptz,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agendar_retorno_whatsapp(uuid,uuid,uuid,uuid,timestamptz,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.interromper_retorno_apos_mensagem()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
BEGIN
  IF NEW.direcao = 'entrada' AND NEW.lead_id IS NOT NULL THEN
    -- A delayed webhook for a message older than the appointment must not cancel it.
    PERFORM 1 FROM leads WHERE id = NEW.lead_id FOR UPDATE;
    UPDATE tarefas SET status = 'cancelada', retorno_cancelado_em = now()
      WHERE lead_id = NEW.lead_id AND retorno_request_id IS NOT NULL AND status = 'pendente'
        AND retorno_cancelado_em IS NULL AND NEW.created_at >= criado_em;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_whatsapp_interromper_retorno ON public.whatsapp_mensagens;
CREATE TRIGGER trg_whatsapp_interromper_retorno AFTER INSERT ON public.whatsapp_mensagens
  FOR EACH ROW EXECUTE FUNCTION public.interromper_retorno_apos_mensagem();
REVOKE ALL ON FUNCTION public.interromper_retorno_apos_mensagem() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.interromper_retorno_apos_mensagem() TO service_role;

-- Assignment and its audit record are one transaction; old orders/commissions untouched.
CREATE OR REPLACE FUNCTION public.transferir_cliente_crm(
  p_cliente_id uuid, p_usuario_id uuid, p_vendedor_id uuid, p_motivo text, p_origem text, p_transferir_tarefas boolean DEFAULT false, p_integracao boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_cliente public.clientes_erp; v_anterior uuid; v_tarefas integer := 0;
BEGIN
  IF NOT (p_usuario_id IS NULL AND p_integracao IS TRUE) AND NOT EXISTS (SELECT 1 FROM usuarios WHERE id=p_usuario_id AND role='admin' AND ativo=true) THEN
    RAISE EXCEPTION 'Somente administrador pode transferir' USING ERRCODE='42501';
  END IF;
  IF p_motivo IS NULL OR length(trim(p_motivo)) NOT BETWEEN 3 AND 1000 OR p_origem IS NULL
    OR p_origem NOT IN ('individual','lote','importacao','integracao','processo_administrativo') THEN
    RAISE EXCEPTION 'Motivo ou origem inválidos' USING ERRCODE='22023';
  END IF;
  IF p_vendedor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM usuarios WHERE id=p_vendedor_id AND ativo=true AND disponivel_como_vendedor=true) THEN
    RAISE EXCEPTION 'Vendedor indisponível' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_cliente FROM clientes_erp WHERE id=p_cliente_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cliente inexistente' USING ERRCODE='P0002'; END IF;
  v_anterior := v_cliente.vendedor_responsavel_usuario_id;
  UPDATE clientes_erp SET vendedor_responsavel_usuario_id=p_vendedor_id,vendedor_atribuicao_manual=true WHERE id=p_cliente_id;
  UPDATE leads SET responsavel_id=p_vendedor_id,updated_at=now() WHERE cliente_erp_id=v_cliente.legacy_id AND responsavel_id IS DISTINCT FROM p_vendedor_id;
  IF p_transferir_tarefas AND p_vendedor_id IS NOT NULL THEN
    UPDATE tarefas SET responsavel_id=p_vendedor_id WHERE lead_id IN(SELECT id FROM leads WHERE cliente_erp_id=v_cliente.legacy_id)
      AND status='pendente' AND responsavel_id IS NOT DISTINCT FROM v_anterior;
    GET DIAGNOSTICS v_tarefas = ROW_COUNT;
  END IF;
  IF v_anterior IS DISTINCT FROM p_vendedor_id THEN
    INSERT INTO clientes_vendedor_historico(cliente_erp_id,vendedor_anterior_id,vendedor_novo_id,usuario_alterou_id,motivo,origem)
      VALUES(p_cliente_id,v_anterior,p_vendedor_id,p_usuario_id,trim(p_motivo),p_origem);
  END IF;
  RETURN jsonb_build_object('alterado',v_anterior IS DISTINCT FROM p_vendedor_id,'tarefas_transferidas',v_tarefas);
END;
$$;
REVOKE ALL ON FUNCTION public.transferir_cliente_crm(uuid,uuid,uuid,text,text,boolean,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transferir_cliente_crm(uuid,uuid,uuid,text,text,boolean,boolean) TO service_role;

-- Search and waiting filters run before pagination. One snapshot returns a
-- prefix and its global count, avoiding cross-page drift in a live inbox.
CREATE OR REPLACE FUNCTION public.listar_caixa_whatsapp(
  p_usuario_id uuid, p_integracao boolean, p_responsavel_id uuid,
  p_sem_responsavel boolean, p_busca text, p_origem text, p_condicao text, p_limite integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE v_role text; v_result jsonb;
BEGIN
  IF p_usuario_id IS NULL AND p_integracao IS TRUE THEN v_role := 'admin';
  ELSE SELECT role INTO v_role FROM usuarios WHERE id=p_usuario_id AND ativo=true; END IF;
  IF v_role IS NULL OR v_role NOT IN ('admin','vendedor','financeiro') THEN
    RAISE EXCEPTION 'Acesso negado' USING ERRCODE='42501';
  END IF;
  IF v_role='vendedor' AND (p_sem_responsavel IS TRUE OR p_responsavel_id IS DISTINCT FROM p_usuario_id) THEN
    RAISE EXCEPTION 'Outra carteira' USING ERRCODE='42501';
  END IF;
  IF p_limite IS NULL OR p_limite NOT BETWEEN 1 AND 1000 OR length(coalesce(p_busca,''))>120
    OR (p_condicao IS NOT NULL AND p_condicao NOT IN ('aguardando','cliente','criticas')) THEN
    RAISE EXCEPTION 'Filtros inválidos' USING ERRCODE='22023';
  END IF;
  WITH matches AS MATERIALIZED (
    SELECT l.id, coalesce(greatest(l.ultima_mensagem_em,w.created_at),l.criado_em) AS atividade,
      w.direcao, w.preview
    FROM leads l
    LEFT JOIN LATERAL (
      SELECT m.created_at,m.direcao,to_jsonb(m)->>'mensagem' AS preview
      FROM whatsapp_mensagens m WHERE m.lead_id=l.id
      ORDER BY m.created_at DESC,m.id DESC LIMIT 1
    ) w ON true
    WHERE (p_responsavel_id IS NULL OR l.responsavel_id=p_responsavel_id)
      AND (p_sem_responsavel IS NOT TRUE OR l.responsavel_id IS NULL)
      AND (p_origem IS NULL OR l.origem=p_origem)
      AND (coalesce(p_busca,'')='' OR position(lower(p_busca) IN lower(coalesce(l.nome,'')||' '||coalesce(l.telefone,'')))>0)
      AND (p_condicao IS NULL
        OR (p_condicao='cliente' AND w.direcao='saida')
        OR (p_condicao IN ('aguardando','criticas') AND w.direcao='entrada'
          AND (p_condicao<>'criticas' OR w.created_at<=now()-interval '30 minutes')
          AND NOT EXISTS(SELECT 1 FROM tarefas t WHERE t.lead_id=l.id
            AND t.retorno_request_id IS NOT NULL AND t.status='pendente'
            AND t.retorno_cancelado_em IS NULL AND t.prazo>now())))
  ), page AS (
    SELECT * FROM matches ORDER BY atividade DESC NULLS LAST,id LIMIT p_limite
  )
  SELECT jsonb_build_object('total',(SELECT count(*) FROM matches),'data',coalesce((
    SELECT jsonb_agg(payload ORDER BY atividade DESC NULLS LAST,id) FROM (
      SELECT p.id,p.atividade,to_jsonb(l)||jsonb_build_object(
        'ultima_mensagem_em',p.atividade,'ultima_mensagem_preview',p.preview,
        'ultima_mensagem_direcao',p.direcao,'tem_mensagem_pendente',p.direcao='entrada',
        'usuarios',CASE WHEN u.id IS NULL THEN NULL ELSE jsonb_build_object('id',u.id,'nome',to_jsonb(u)->'nome') END,
        'cliente_erp_vinculado',CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object('id',c.id,'legacy_id',c.legacy_id,'razao_social',to_jsonb(c)->'razao_social') END
      ) AS payload
      FROM page p JOIN leads l ON l.id=p.id LEFT JOIN usuarios u ON u.id=l.responsavel_id
      LEFT JOIN clientes_erp c ON c.legacy_id=l.cliente_erp_id
    ) rows
  ),'[]'::jsonb)) INTO v_result;
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.listar_caixa_whatsapp(uuid,boolean,uuid,boolean,text,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.listar_caixa_whatsapp(uuid,boolean,uuid,boolean,text,text,text,integer) TO service_role;
