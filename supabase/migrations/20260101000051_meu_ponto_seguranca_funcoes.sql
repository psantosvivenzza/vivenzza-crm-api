-- Correção estrutural (revisão de 2026-09-11, terceira rodada): as funções
-- ponto_decidir_solicitacao/ponto_decidir_correcao (migration 050)
-- resolviam ATOMICIDADE, mas não AUTORIZAÇÃO de verdade. Três problemas
-- reais:
--
-- 1. Sem SECURITY/search_path explícitos, nem REVOKE/GRANT — em Postgres,
--    CREATE FUNCTION concede EXECUTE a PUBLIC por padrão. Qualquer papel
--    com permissão de chamar RPC (em Supabase real: potencialmente `anon`/
--    `authenticated` via PostgREST, dependendo de como o projeto estiver
--    configurado) poderia, em tese, chamar a função DIRETO, contornando
--    toda a checagem de escopo que só existe no Express
--    (src/routes/ponto-gestao.js).
-- 2. p_decisor_id é um parâmetro qualquer que o CHAMADOR informa — a
--    função nunca verificava se esse decisor de fato tem escopo sobre o
--    colaborador da solicitação/correção, nem se está ativo. Confiava
--    inteiramente que quem chamasse a função (hoje: só o Express, depois
--    de já ter checado) mandaria um p_decisor_id legítimo. Um chamador
--    direto poderia informar QUALQUER uuid como decisor.
-- 3. search_path não fixado — risco clássico de search_path hijacking
--    (um role malicioso criando um schema com um objeto de mesmo nome que
--    passe na frente do public no search_path da sessão).
--
-- Esta migration redefine as duas funções com: SECURITY INVOKER explícito
-- (nunca DEFINER — a função deve rodar com os privilégios de quem chama,
-- não elevar; a autorização real está nas checagens abaixo, não em rodar
-- como um "super-usuário" da aplicação), SET search_path fixo, REVOKE de
-- PUBLIC, GRANT só para o papel de serviço real (condicional — ver nota de
-- ambiente abaixo), e validação de escopo/ativo DENTRO da função — não só
-- nos argumentos confiados pelo chamador.
--
-- NOTA DE AMBIENTE (pendência documentada, não verificada): o GRANT abaixo
-- mira o papel `service_role`, convenção padrão do Supabase para a chave
-- SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY que este backend usa (ver
-- src/lib/supabase-admin.server.js). Isso NUNCA foi confirmado contra o
-- projeto Supabase real desta conta — só assumido pela convenção. Os
-- blocos condicionais abaixo (`IF EXISTS ... pg_roles`) evitam erro caso
-- o papel não exista (é o caso do Postgres local de teste, que não tem
-- anon/authenticated/service_role) — aplicar em produção exige confirmar
-- o nome real do papel antes.

BEGIN;

CREATE OR REPLACE FUNCTION public.ponto_decidir_solicitacao(
  p_solicitacao_id uuid,
  p_decisor_id uuid,
  p_decisao text,
  p_decisao_justificativa text
) RETURNS TABLE (
  resultado text,
  solicitacao_id uuid,
  status text,
  decidido_por uuid,
  decidido_em timestamptz,
  marcacao_gerada_id uuid
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_solic public.ponto_solicitacoes_marcacao%ROWTYPE;
  v_nova_marcacao_id uuid;
  v_piloto_ativo boolean;
  v_decisor_role text;
  v_decisor_ativo boolean;
  v_tem_escopo boolean;
BEGIN
  IF p_decisao NOT IN ('aprovada', 'rejeitada') THEN
    RAISE EXCEPTION 'decisao_invalida' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_solic FROM public.ponto_solicitacoes_marcacao WHERE id = p_solicitacao_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'solicitacao_nao_encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_solic.usuario_id = p_decisor_id THEN
    RAISE EXCEPTION 'autoaprovacao_bloqueada' USING ERRCODE = 'P0003';
  END IF;

  -- Autorização de verdade, dentro da função — não confia que o chamador
  -- (Express, hoje; qualquer coisa com EXECUTE, em tese) já filtrou isso.
  SELECT role, ativo INTO v_decisor_role, v_decisor_ativo FROM public.usuarios WHERE id = p_decisor_id;
  IF NOT FOUND OR NOT COALESCE(v_decisor_ativo, false) THEN
    RAISE EXCEPTION 'decisor_invalido_ou_inativo' USING ERRCODE = 'P0005';
  END IF;
  IF v_decisor_role <> 'admin' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ponto_gestores
      WHERE gestor_usuario_id = p_decisor_id
        AND colaborador_usuario_id = v_solic.usuario_id
        AND revogado_em IS NULL
    ) INTO v_tem_escopo;
    IF NOT v_tem_escopo THEN
      RAISE EXCEPTION 'fora_do_escopo' USING ERRCODE = 'P0006';
    END IF;
  END IF;

  IF v_solic.status <> 'pendente' THEN
    RETURN QUERY SELECT 'ja_decidida_antes'::text, v_solic.id, v_solic.status, v_solic.decidido_por, v_solic.decidido_em, v_solic.marcacao_gerada_id;
    RETURN;
  END IF;

  IF p_decisao = 'aprovada' THEN
    SELECT piloto_ativo INTO v_piloto_ativo FROM public.ponto_config WHERE id = true;
    IF NOT COALESCE(v_piloto_ativo, false) THEN
      RAISE EXCEPTION 'piloto_desativado' USING ERRCODE = 'P0004';
    END IF;
  END IF;

  UPDATE public.ponto_solicitacoes_marcacao
  SET status = p_decisao, decidido_por = p_decisor_id, decidido_em = now(), decisao_justificativa = p_decisao_justificativa
  WHERE id = p_solicitacao_id;

  IF p_decisao = 'aprovada' THEN
    INSERT INTO public.ponto_marcacoes (
      operacao_id, usuario_id, tipo, origem, registrado_em, dia_brt,
      foto_id, justificativa_contingencia, sinalizado_para_revisao,
      motivo_sinalizacao, origem_solicitacao_id
    ) VALUES (
      gen_random_uuid(), v_solic.usuario_id, v_solic.tipo, 'contingencia', v_solic.capturado_em, v_solic.dia_brt,
      v_solic.foto_id, v_solic.justificativa, true,
      'aprovada via solicitação de marcação (equipamento não verificado nesta etapa)', v_solic.id
    ) RETURNING id INTO v_nova_marcacao_id;

    UPDATE public.ponto_solicitacoes_marcacao SET marcacao_gerada_id = v_nova_marcacao_id WHERE id = p_solicitacao_id;
  END IF;

  RETURN QUERY SELECT 'decidida_agora'::text, p_solicitacao_id, p_decisao, p_decisor_id, now(), v_nova_marcacao_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.ponto_decidir_correcao(
  p_correcao_id uuid,
  p_decisor_id uuid,
  p_decisao text,
  p_decisao_justificativa text
) RETURNS TABLE (
  resultado text,
  correcao_id uuid,
  status text,
  decidido_por uuid,
  decidido_em timestamptz,
  marcacao_gerada_id uuid
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_correcao public.ponto_correcoes%ROWTYPE;
  v_nova_marcacao_id uuid;
  v_piloto_ativo boolean;
  v_tipo text;
  v_registrado_em timestamptz;
  v_gera_marcacao boolean;
  v_decisor_role text;
  v_decisor_ativo boolean;
  v_tem_escopo boolean;
BEGIN
  IF p_decisao NOT IN ('aprovada', 'rejeitada') THEN
    RAISE EXCEPTION 'decisao_invalida' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_correcao FROM public.ponto_correcoes WHERE id = p_correcao_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'correcao_nao_encontrada' USING ERRCODE = 'P0002';
  END IF;

  IF v_correcao.solicitado_por = p_decisor_id THEN
    RAISE EXCEPTION 'autoaprovacao_bloqueada' USING ERRCODE = 'P0003';
  END IF;

  SELECT role, ativo INTO v_decisor_role, v_decisor_ativo FROM public.usuarios WHERE id = p_decisor_id;
  IF NOT FOUND OR NOT COALESCE(v_decisor_ativo, false) THEN
    RAISE EXCEPTION 'decisor_invalido_ou_inativo' USING ERRCODE = 'P0005';
  END IF;
  IF v_decisor_role <> 'admin' THEN
    SELECT EXISTS (
      SELECT 1 FROM public.ponto_gestores
      WHERE gestor_usuario_id = p_decisor_id
        AND colaborador_usuario_id = v_correcao.usuario_id
        AND revogado_em IS NULL
    ) INTO v_tem_escopo;
    IF NOT v_tem_escopo THEN
      RAISE EXCEPTION 'fora_do_escopo' USING ERRCODE = 'P0006';
    END IF;
  END IF;

  IF v_correcao.status <> 'pendente' THEN
    RETURN QUERY SELECT 'ja_decidida_antes'::text, v_correcao.id, v_correcao.status, v_correcao.decidido_por, v_correcao.decidido_em, v_correcao.marcacao_gerada_id;
    RETURN;
  END IF;

  v_gera_marcacao := p_decisao = 'aprovada' AND v_correcao.tipo_solicitacao IN ('ajuste_horario', 'ajuste_tipo', 'inclusao_marcacao_faltante');

  IF v_gera_marcacao THEN
    SELECT piloto_ativo INTO v_piloto_ativo FROM public.ponto_config WHERE id = true;
    IF NOT COALESCE(v_piloto_ativo, false) THEN
      RAISE EXCEPTION 'piloto_desativado' USING ERRCODE = 'P0004';
    END IF;

    -- Correção estrutural (revisão de 2026-09-12): antes desta checagem, um
    -- valor_proposto sem tipo/registrado_em válidos (deveria ser bloqueado
    -- na criação por POST /api/ponto/correcoes, mas nunca se pode confiar
    -- só na checagem em JS — mesma disciplina do resto deste módulo) fazia
    -- esta função marcar a correção como 'aprovada' e simplesmente pular o
    -- INSERT da marcação, em silêncio — sem erro, sem marcacao_gerada_id,
    -- sem qualquer sinal pro gestor de que a aprovação não produziu nada.
    -- Falhar aqui, ANTES do UPDATE de status, mantém a correção 'pendente'
    -- (nada commitado) em vez de "aprovada" sem efeito nenhum.
    v_tipo := v_correcao.valor_proposto->>'tipo';
    v_registrado_em := NULLIF(v_correcao.valor_proposto->>'registrado_em', '')::timestamptz;
    IF v_tipo NOT IN ('entrada', 'saida_intervalo', 'retorno_intervalo', 'saida') OR v_registrado_em IS NULL THEN
      RAISE EXCEPTION 'valor_proposto_invalido' USING ERRCODE = 'P0013';
    END IF;
  END IF;

  UPDATE public.ponto_correcoes
  SET status = p_decisao, decidido_por = p_decisor_id, decidido_em = now(), decisao_justificativa = p_decisao_justificativa
  WHERE id = p_correcao_id;

  IF v_gera_marcacao THEN
    INSERT INTO public.ponto_marcacoes (
      operacao_id, usuario_id, tipo, origem, registrado_em, dia_brt, origem_correcao_id, sinalizado_para_revisao
    ) VALUES (
      gen_random_uuid(), v_correcao.usuario_id, v_tipo, 'correcao', v_registrado_em,
      (v_registrado_em AT TIME ZONE 'America/Sao_Paulo')::date, v_correcao.id, false
    ) RETURNING id INTO v_nova_marcacao_id;

    UPDATE public.ponto_correcoes SET marcacao_gerada_id = v_nova_marcacao_id WHERE id = p_correcao_id;
  END IF;

  RETURN QUERY SELECT 'decidida_agora'::text, p_correcao_id, p_decisao, p_decisor_id, now(), v_nova_marcacao_id;
END;
$$;

-- PUBLIC nunca deve poder chamar estas funções direto — só o papel de
-- serviço que o backend usa. REVOKE de PUBLIC sempre existe como papel;
-- os GRANTs condicionais abaixo cobrem os papéis reais do Supabase quando
-- existirem (produção) e não quebram o Postgres local de teste (onde não
-- existem).
REVOKE ALL ON FUNCTION public.ponto_decidir_solicitacao(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ponto_decidir_correcao(uuid, uuid, text, text) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.ponto_decidir_solicitacao(uuid, uuid, text, text) TO service_role;
    GRANT EXECUTE ON FUNCTION public.ponto_decidir_correcao(uuid, uuid, text, text) TO service_role;
  END IF;
  -- anon/authenticated nunca devem ter EXECUTE nestas funções — não há
  -- GRANT nenhum pra eles, de propósito (silêncio, não um REVOKE
  -- redundante: REVOKE ALL FROM PUBLIC acima já cobre qualquer papel que
  -- herde de PUBLIC, que é o caso padrão de anon/authenticated no Supabase).
END $$;

COMMIT;
