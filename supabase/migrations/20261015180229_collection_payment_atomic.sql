-- PROPOSTA LOCAL: nao aplicada. Gerar migration via CLI antes de promover.
-- Futuro apenas: nenhuma reconstrucao ou alteracao de eventos historicos.
BEGIN;
CREATE FUNCTION public.collection_fulfill_promise_atomic(p_promise_id uuid, p_origin text DEFAULT 'SYSTEM')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '5s' AS $$
DECLARE v_title uuid; v_p public.collection_promises%ROWTYPE;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'READ COMMITTED required' USING ERRCODE='25001'; END IF;
  IF p_promise_id IS NULL OR p_origin IS NULL OR p_origin NOT IN ('AUTOMATION','AI','HUMAN','SYSTEM','PAYMENT_RECONCILIATION') THEN
    RAISE EXCEPTION 'Invalid promise transition arguments' USING ERRCODE = '22023';
  END IF;
  SELECT contas_financeiras_id INTO v_title FROM public.collection_promises WHERE id=p_promise_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('collection-payment:' || v_title::text, 0));
  UPDATE public.collection_promises SET status='cumprida', fulfilled_at=pg_catalog.clock_timestamp()
    WHERE id=p_promise_id AND status='ativa' RETURNING * INTO v_p;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.collection_timeline_events(contas_financeiras_id,cliente_telefone,tipo,origem,descricao,dados,criado_em)
    VALUES(v_p.contas_financeiras_id,v_p.cliente_telefone,'PROMESSA_CUMPRIDA',p_origin,
      'Promessa de pagamento cumprida',pg_catalog.jsonb_build_object('promise_id',p_promise_id),pg_catalog.clock_timestamp());
  RETURN pg_catalog.to_jsonb(v_p);
END;
$$;

CREATE FUNCTION public.collection_cancel_paid_atomic(p_title_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' SET lock_timeout = '5s' AS $$
DECLARE v_t public.contas_financeiras%ROWTYPE; v_reason text; v_d integer:=0; v_c integer:=0;
  v_p uuid; v_fulfilled boolean:=false; v_result jsonb; v_promise_event_at timestamptz;
BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN RAISE EXCEPTION 'READ COMMITTED required' USING ERRCODE='25001'; END IF;
  IF p_title_id IS NULL THEN RAISE EXCEPTION 'Missing title' USING ERRCODE='22023'; END IF;
  -- Mesmo lock nas duas RPCs; tambem serializa o caso titulo inexistente.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('collection-payment:' || p_title_id::text,0));
  SELECT * INTO v_t FROM public.contas_financeiras WHERE id=p_title_id FOR UPDATE;
  IF NOT FOUND THEN v_reason:='titulo_inexistente';
  ELSIF v_t.status='cancelada' THEN v_reason:='cancelado';
  ELSIF v_t.em_revisao_financeira THEN v_reason:='em_revisao_financeira';
  ELSIF coalesce(v_t.valor,0)-coalesce(v_t.valor_pago,0)<=0 THEN v_reason:='quitado';
  ELSE RETURN pg_catalog.jsonb_build_object('dispatches',0,'promessaCumprida',false,'ligacoes',0,'motivo',NULL);
  END IF;
  UPDATE public.collection_dispatches SET status='cancelled',cancelado_em=pg_catalog.clock_timestamp(),cancelado_motivo=v_reason
    WHERE contas_financeiras_id=p_title_id AND status IN ('queued','sending');
  GET DIAGNOSTICS v_d=ROW_COUNT;
  -- Ausencia opcional confirmada no schema. Erros de coluna/permissao propagam.
  IF pg_catalog.to_regclass('public.collection_calls') IS NOT NULL THEN
    EXECUTE 'UPDATE public.collection_calls SET status=''cancelada'' WHERE contas_financeiras_id=$1 AND status IN (''agendada'',''em_andamento'')' USING p_title_id;
    GET DIAGNOSTICS v_c=ROW_COUNT;
  END IF;
  IF v_reason='quitado' THEN
    SELECT id INTO v_p FROM public.collection_promises WHERE contas_financeiras_id=p_title_id AND status='ativa';
    IF FOUND THEN
      v_fulfilled:=public.collection_fulfill_promise_atomic(v_p,'PAYMENT_RECONCILIATION') IS NOT NULL;
      IF v_fulfilled THEN
        SELECT max(criado_em) INTO v_promise_event_at FROM public.collection_timeline_events
          WHERE contas_financeiras_id=p_title_id AND tipo='PROMESSA_CUMPRIDA' AND dados->>'promise_id'=v_p::text;
      END IF;
    END IF;
  END IF;
  v_result:=pg_catalog.jsonb_build_object('dispatches',v_d,'promessaCumprida',v_fulfilled,'ligacoes',v_c,'motivo',v_reason);
  IF v_reason='quitado' AND (v_d>0 OR v_c>0 OR v_fulfilled) AND NOT EXISTS(
    SELECT 1 FROM public.collection_timeline_events WHERE contas_financeiras_id=p_title_id AND tipo='PAGO'
  ) THEN
    INSERT INTO public.collection_timeline_events(contas_financeiras_id,tipo,origem,descricao,dados,criado_em)
      VALUES(p_title_id,'PAGO','PAYMENT_RECONCILIATION',
        pg_catalog.format('Automação cancelada por pagamento confirmado (%s disparo(s), %s ligação(ões), promessa cumprida=%s)',v_d,v_c,CASE WHEN v_fulfilled THEN 'true' ELSE 'false' END),v_result,
        -- Ordem monotona para os dois eventos desta transicao, mesmo sob relogio de baixa resolucao.
        greatest(pg_catalog.clock_timestamp(),v_promise_event_at + interval '1 microsecond'));
  END IF;
  RETURN v_result;
END;
$$;
-- Proposta de ACL somente destas novas funcoes, sem alterar papeis/tabelas existentes.
REVOKE ALL ON FUNCTION public.collection_fulfill_promise_atomic(uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.collection_cancel_paid_atomic(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.collection_fulfill_promise_atomic(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.collection_cancel_paid_atomic(uuid) TO service_role;
COMMIT;
