-- Pedido humano de 19/10/2026: cobrança mantém sua cota; frete é à parte,
-- uma tentativa a cada 60 segundos. Aplicar em transação única antes da API.
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';

-- Assinatura preservada para versões já publicadas da API e motor legado.
-- Este contador passa a representar SOMENTE cobrança, nunca frete.
CREATE OR REPLACE FUNCTION public.frete_contar_orcamento(p_desde timestamptz,p_instancia text DEFAULT NULL)
RETURNS bigint LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT
 (CASE WHEN EXISTS(SELECT 1 FROM public.frete_orcamento_controle WHERE ativado_em IS NOT NULL)
  OR COALESCE((SELECT multi_whatsapp FROM public.automacoes_config WHERE id=1),false)
  THEN (SELECT count(*) FROM public.collection_dispatch_attempts a
   JOIN public.collection_dispatches d ON d.id=a.dispatch_id
   LEFT JOIN public.whatsapp_instances i ON i.id=a.whatsapp_instance_id
   WHERE d.purpose='collection' AND a.criado_em>=p_desde
    AND (p_instancia IS NULL OR i.instance_name=p_instancia)) ELSE 0 END)
 +(SELECT count(*) FROM public.frete_reservas_legado r WHERE r.created_at>=p_desde
   AND (p_instancia IS NULL OR r.instance_name=p_instancia))
 +(SELECT count(*) FROM public.cobrancas_whatsapp c CROSS JOIN public.frete_orcamento_controle o
   WHERE ((o.ativado_em IS NOT NULL AND o.contar_historico_legado AND c.data_envio<o.ativado_em)
    OR (o.ativado_em IS NULL AND NOT COALESCE((SELECT multi_whatsapp FROM public.automacoes_config WHERE id=1),false)))
    AND c.data_envio>=p_desde AND (p_instancia IS NULL OR p_instancia=o.instancia_legado));
$$;

CREATE OR REPLACE FUNCTION public.frete_guardar_orcamento()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE instancia text; cfg public.automacoes_config; i public.whatsapp_instances;
 dia timestamptz; hora timestamptz; ativo boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(78141015);
 SELECT o.ativo INTO ativo FROM public.frete_orcamento_controle o WHERE id=1;
 IF NOT COALESCE(ativo,false) THEN
  IF tg_table_name='frete_envios' THEN RAISE EXCEPTION 'Controle de envios ainda nao ativado.'; END IF;
  RETURN new;
 END IF;
 IF tg_table_name='frete_envios' THEN
  IF new.instance_name IS DISTINCT FROM 'vivenzza-financeiro' THEN RAISE EXCEPTION 'Instancia de frete invalida.'; END IF;
  SELECT * INTO i FROM public.whatsapp_instances WHERE instance_name=new.instance_name;
  IF NOT FOUND OR NOT i.enabled THEN RAISE EXCEPTION 'Instancia indisponivel para reserva.'; END IF;
  IF EXISTS(SELECT 1 FROM public.frete_envios e WHERE e.id<>new.id
    AND e.attempted_at>clock_timestamp()-interval '60 seconds') THEN
   RAISE EXCEPTION 'limite_frete_cadencia';
  END IF;
  new.attempted_at:=clock_timestamp();
  RETURN new;
 END IF;
 IF tg_table_name='collection_dispatch_attempts' THEN
  IF NOT EXISTS(SELECT 1 FROM public.collection_dispatches d WHERE d.id=new.dispatch_id AND d.purpose='collection') THEN RETURN new; END IF;
  SELECT instance_name INTO instancia FROM public.whatsapp_instances WHERE id=new.whatsapp_instance_id;
 ELSE instancia:=new.instance_name; END IF;
 SELECT * INTO cfg FROM public.automacoes_config WHERE id=1;
 dia:=date_trunc('day',clock_timestamp() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
 hora:=date_trunc('hour',clock_timestamp());
 IF public.frete_contar_orcamento(dia)>=(CASE WHEN cfg.id IS NULL THEN 30 ELSE cfg.global_daily_limit END)
  OR public.frete_contar_orcamento(hora)>=(CASE WHEN cfg.id IS NULL THEN 10 ELSE cfg.global_hourly_limit END)
 THEN RAISE EXCEPTION 'limite_global_reserva'; END IF;
 SELECT * INTO i FROM public.whatsapp_instances WHERE instance_name=instancia;
 IF NOT FOUND OR NOT i.enabled THEN RAISE EXCEPTION 'Instancia indisponivel para reserva.'; END IF;
 IF public.frete_contar_orcamento(dia,instancia)>=i.daily_limit
  OR public.frete_contar_orcamento(hora,instancia)>=i.hourly_limit
 THEN RAISE EXCEPTION 'limite_instancia_reserva'; END IF;
 RETURN new;
END $$;

DO $cadencia$
DECLARE definition text:=pg_get_functiondef('public.frete_claim_envio(uuid)'::regprocedure);
BEGIN
 IF strpos(definition,'interval ''90 seconds''')>0 THEN
  EXECUTE replace(definition,'interval ''90 seconds''','interval ''60 seconds''');
 ELSIF strpos(definition,'interval ''60 seconds''')=0 THEN
  RAISE EXCEPTION 'Cadencia do claim mudou; revisar antes de aplicar.';
 END IF;
END $cadencia$;

-- O índice parcial frete_envios_tentativas já cobre attempted_at; não duplicar.
