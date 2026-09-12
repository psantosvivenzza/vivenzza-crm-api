-- Meu Ponto — registro atômico de marcação assinada por equipamento.
--
-- Mesma disciplina de segurança da migration 051 (SECURITY INVOKER
-- explícito, search_path fixo, REVOKE de PUBLIC, GRANT condicional só para
-- service_role, revalidação fresca dentro da função — nunca confiar em
-- pré-checagem feita em JS).
--
-- LIMITE DESTA FUNÇÃO (documentado, não escondido): ela NÃO verifica a
-- assinatura criptográfica do equipamento — Postgres não tem, sem extensão
-- adicional, verificação nativa de ECDSA P-256 sobre uma chave em formato
-- JWK. Essa verificação acontece em Node (node:crypto/OpenSSL) ANTES desta
-- função ser chamada (ver src/lib/ponto/assinaturaEquipamento.js). O que
-- esta função garante é a parte que Postgres faz bem: atomicidade e
-- frescor — consumo do nonce, revalidação do equipamento/usuário, e
-- inserção da marcação acontecem em uma única transação, com FOR UPDATE
-- serializando tentativas concorrentes sobre o mesmo nonce. Um chamador
-- que consiga invocar esta função direto (contornando a verificação de
-- assinatura em Node) ainda precisa de um nonce real, não expirado, não
-- usado, vinculado ao equipamento/usuário corretos — mas a prova
-- criptográfica de posse da chave privada não é re-verificada aqui. Isso é
-- o mesmo tipo de fronteira já documentado para p_decisor_id na migration
-- 051: a função prova consistência de estado, não identidade por si só.

BEGIN;

CREATE OR REPLACE FUNCTION public.ponto_registrar_marcacao_assinada(
  p_nonce text,
  p_equipamento_id uuid,
  p_usuario_id uuid,
  p_operacao_id uuid,
  p_tipo text,
  p_hash_conteudo text,
  p_foto_id uuid,
  p_ip_registro inet,
  p_sinalizado_para_revisao boolean,
  p_motivo_sinalizacao text
) RETURNS TABLE (
  resultado text,
  marcacao_id uuid,
  tipo text,
  origem text,
  registrado_em timestamptz,
  dia_brt date,
  sinalizado_para_revisao boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existente public.ponto_marcacoes%ROWTYPE;
  v_desafio public.ponto_desafios%ROWTYPE;
  v_equip public.ponto_equipamentos%ROWTYPE;
  v_usuario_ativo boolean;
  v_piloto_ativo boolean;
  v_nova_id uuid;
  v_dia_brt date;
BEGIN
  -- Idempotência primeiro: mesmo operacao_id já processado devolve o que já
  -- existe, nunca tenta consumir o nonce de novo — é assim que uma
  -- recuperação após timeout de rede (protocolo §1, passo 7) evita
  -- duplicar a marcação. Reenvio do MESMO operacao_id com um tipo
  -- DIFERENTE nunca é tratado como "a mesma operação" (mesma disciplina de
  -- POST /solicitacoes, ver especificação seção 2.3) — devolver
  -- silenciosamente a marcação antiga esconderia do chamador que a
  -- segunda tentativa, com dado diferente, nunca foi registrada.
  SELECT * INTO v_existente FROM public.ponto_marcacoes WHERE operacao_id = p_operacao_id;
  IF FOUND THEN
    IF v_existente.tipo IS DISTINCT FROM p_tipo THEN
      RAISE EXCEPTION 'operacao_id_conteudo_diferente' USING ERRCODE = 'P0014';
    END IF;
    RETURN QUERY SELECT 'ja_registrada_antes'::text, v_existente.id, v_existente.tipo, v_existente.origem, v_existente.registrado_em, v_existente.dia_brt, v_existente.sinalizado_para_revisao;
    RETURN;
  END IF;

  SELECT ativo INTO v_usuario_ativo FROM public.usuarios WHERE id = p_usuario_id;
  IF NOT FOUND OR NOT COALESCE(v_usuario_ativo, false) THEN
    RAISE EXCEPTION 'usuario_invalido_ou_inativo' USING ERRCODE = 'P0012';
  END IF;

  SELECT piloto_ativo INTO v_piloto_ativo FROM public.ponto_config WHERE id = true;
  IF NOT COALESCE(v_piloto_ativo, false) THEN
    RAISE EXCEPTION 'piloto_desativado' USING ERRCODE = 'P0004';
  END IF;

  -- Um nonce que exista mas pertença a outro equipamento/usuário é tratado
  -- como "não encontrado" — não vazamos qual parte da combinação não
  -- bateu.
  SELECT * INTO v_desafio FROM public.ponto_desafios
    WHERE nonce = p_nonce AND equipamento_id = p_equipamento_id AND usuario_id = p_usuario_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'desafio_nao_encontrado' USING ERRCODE = 'P0007';
  END IF;
  IF v_desafio.usado_em IS NOT NULL THEN
    RAISE EXCEPTION 'desafio_ja_usado' USING ERRCODE = 'P0008';
  END IF;
  IF v_desafio.expira_em < now() THEN
    RAISE EXCEPTION 'desafio_expirado' USING ERRCODE = 'P0009';
  END IF;
  IF v_desafio.tipo IS DISTINCT FROM p_tipo OR v_desafio.hash_conteudo IS DISTINCT FROM p_hash_conteudo THEN
    RAISE EXCEPTION 'conteudo_nao_confere' USING ERRCODE = 'P0011';
  END IF;

  -- Revalida o equipamento fresco dentro da transação — nunca confia num
  -- status pré-checado em JS (mesma disciplina de exigirUsuarioAtivo/
  -- escopo de gestor aplicada ao resto do módulo).
  SELECT * INTO v_equip FROM public.ponto_equipamentos WHERE id = p_equipamento_id FOR UPDATE;
  IF NOT FOUND OR v_equip.status <> 'ativo' OR v_equip.usuario_id <> p_usuario_id OR v_equip.modo <> 'producao' THEN
    RAISE EXCEPTION 'equipamento_invalido_ou_revogado' USING ERRCODE = 'P0010';
  END IF;

  UPDATE public.ponto_desafios SET usado_em = now(), operacao_id = p_operacao_id WHERE id = v_desafio.id;

  v_dia_brt := (now() AT TIME ZONE 'America/Sao_Paulo')::date;

  INSERT INTO public.ponto_marcacoes (
    operacao_id, usuario_id, tipo, origem, dia_brt, foto_id, equipamento_id,
    ip_registro, sinalizado_para_revisao, motivo_sinalizacao
  ) VALUES (
    p_operacao_id, p_usuario_id, p_tipo, 'normal', v_dia_brt, p_foto_id, p_equipamento_id,
    p_ip_registro, COALESCE(p_sinalizado_para_revisao, false), p_motivo_sinalizacao
  ) RETURNING id INTO v_nova_id;

  RETURN QUERY SELECT 'registrada_agora'::text, v_nova_id, p_tipo, 'normal'::text, now(), v_dia_brt, COALESCE(p_sinalizado_para_revisao, false);
END;
$$;

REVOKE ALL ON FUNCTION public.ponto_registrar_marcacao_assinada(
  text, uuid, uuid, uuid, text, text, uuid, inet, boolean, text
) FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.ponto_registrar_marcacao_assinada(
      text, uuid, uuid, uuid, text, text, uuid, inet, boolean, text
    ) TO service_role;
  END IF;
END $$;

COMMIT;
