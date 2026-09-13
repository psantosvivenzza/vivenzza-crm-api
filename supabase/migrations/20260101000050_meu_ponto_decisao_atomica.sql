-- Correção estrutural (revisão de 2026-09-10, segunda rodada): decidir uma
-- solicitação/correção fazia DOIS passos separados a partir do Node
-- (UPDATE de status, depois INSERT da marcação, depois outro UPDATE pra
-- linkar) — sem transação alguma amarrando os três. Se o INSERT da
-- marcação falhasse (fault real, não só hipotético — já vimos isso com o
-- gatilho de teste em ponto_solicitacoes_marcacao), o UPDATE de status já
-- tinha comitado: a solicitação ficava "aprovada" pra sempre, sem nenhuma
-- marcação correspondente. Esta migration move a decisão inteira pra uma
-- função Postgres (mesmo padrão de fn_aprovar_estorno/fn_baixar_titulo já
-- usado no projeto) — uma chamada de função roda como UMA transação: se
-- qualquer passo falhar, tudo volta, a solicitação permanece pendente.
-- `SELECT ... FOR UPDATE` também serializa decisões concorrentes na mesma
-- linha (a segunda chamada só prossegue depois que a primeira commitar, e
-- nesse ponto já vê o status novo) — nunca duas marcações pra uma
-- solicitação, nunca duas decisões válidas.

BEGIN;

-- Rastreabilidade marcação -> solicitação de origem (paralelo a
-- origem_correcao_id, que já existe pra correções). Toda marcação
-- origem='contingencia' nesta etapa vem de uma solicitação aprovada —
-- nunca de criação direta (bloqueada por EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA,
-- ver src/lib/ponto/equipamento.js) — então a constraint abaixo torna isso
-- uma garantia do banco, não só uma convenção da aplicação.
ALTER TABLE public.ponto_marcacoes
  ADD COLUMN IF NOT EXISTS origem_solicitacao_id uuid REFERENCES public.ponto_solicitacoes_marcacao(id);

ALTER TABLE public.ponto_marcacoes
  ADD CONSTRAINT ponto_marcacoes_contingencia_exige_origem_solicitacao
  CHECK (origem <> 'contingencia' OR origem_solicitacao_id IS NOT NULL);

-- Proteção extra no banco (além do UNIQUE natural de operacao_id em
-- ponto_marcacoes e do FOR UPDATE na função): nenhuma solicitação pode
-- terminar linkada a mais de uma marcação.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ponto_marcacoes_origem_solicitacao
  ON public.ponto_marcacoes (origem_solicitacao_id)
  WHERE origem_solicitacao_id IS NOT NULL;

-- Horário DECLARADO pelo colaborador (opcional, nunca obrigatório) —
-- distinto de capturado_em (hora de recebimento no servidor, sempre
-- automática) e de decidido_em (hora da decisão do gestor). Nunca usado
-- como registrado_em da marcação resultante — é só contexto pro gestor
-- avaliar, exibido sempre rotulado como "declarado pelo colaborador".
ALTER TABLE public.ponto_solicitacoes_marcacao
  ADD COLUMN IF NOT EXISTS horario_declarado timestamptz;

-- CORREÇÃO (revisão de 2026-09-11): uma versão anterior desta migration
-- chegou a remover a FK de ponto_solicitacoes_marcacao.marcacao_gerada_id
-- (definida inline lá na migration 049, referenciando ponto_marcacoes),
-- alegando referência circular com ponto_marcacoes.origem_solicitacao_id
-- (que referencia ponto_solicitacoes_marcacao) — as duas colunas apontam
-- uma pra outra entre a mesma solicitação e a mesma marcação. Isso É
-- verdade e trava um DELETE ingênuo, mas remover a FK enfraquecia o schema
-- pra resolver um problema que era só ORDEM de limpeza em teste — a
-- referência circular se resolve com um UPDATE ... SET marcacao_gerada_id
-- = NULL antes do DELETE (ver scripts/tests/ponto/_setup.mjs, helper
-- limparVinculosCircularesDeTeste), não removendo a integridade
-- referencial real. A FK original da migration 049 nunca precisou ser
-- tocada aqui — nenhuma referência órfã é aceita em nenhum dos dois
-- sentidos, e o vínculo solicitação<->marcação continua único e
-- rastreável nos dois sentidos.

-- Rastreabilidade correção -> marcação gerada (mesma FK real que
-- ponto_solicitacoes_marcacao já tinha desde a migration 049 — nenhuma
-- referência órfã aceita).
ALTER TABLE public.ponto_correcoes
  ADD COLUMN IF NOT EXISTS marcacao_gerada_id uuid REFERENCES public.ponto_marcacoes(id);

-- Decisão atômica sobre solicitação de marcação. Resultado:
-- 'decidida_agora' (esta chamada decidiu de verdade) ou 'ja_decidida_antes'
-- (corrida perdida — devolve o estado real, não um erro genérico, pra
-- quem chamou poder recuperar o resultado após um timeout).
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
) AS $$
DECLARE
  v_solic public.ponto_solicitacoes_marcacao%ROWTYPE;
  v_nova_marcacao_id uuid;
  v_piloto_ativo boolean;
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

  IF v_solic.status <> 'pendente' THEN
    RETURN QUERY SELECT 'ja_decidida_antes'::text, v_solic.id, v_solic.status, v_solic.decidido_por, v_solic.decidido_em, v_solic.marcacao_gerada_id;
    RETURN;
  END IF;

  -- Piloto desativado nunca pode produzir uma marcação nova — mesmo que a
  -- solicitação já estivesse pendente de antes de desativar. Rejeitar
  -- continua permitido (não produz marcação, ajuda a esvaziar a fila).
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
    -- registrado_em = capturado_em da SOLICITAÇÃO (o instante real da
    -- tentativa, recebido no servidor) — nunca now() (isso seria a hora da
    -- decisão do gestor, não a hora trabalhada).
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
$$ LANGUAGE plpgsql;

-- Mesma lógica, para correção sobre marcação já confirmada. Só
-- ajuste_horario/ajuste_tipo/inclusao_marcacao_faltante geram marcação
-- nova quando aprovados (mesma regra que já existia em JS); 'outro' fica
-- só registrado, sem efeito automático.
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
) AS $$
DECLARE
  v_correcao public.ponto_correcoes%ROWTYPE;
  v_nova_marcacao_id uuid;
  v_piloto_ativo boolean;
  v_tipo text;
  v_registrado_em timestamptz;
  v_gera_marcacao boolean;
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
  END IF;

  UPDATE public.ponto_correcoes
  SET status = p_decisao, decidido_por = p_decisor_id, decidido_em = now(), decisao_justificativa = p_decisao_justificativa
  WHERE id = p_correcao_id;

  IF v_gera_marcacao THEN
    v_tipo := v_correcao.valor_proposto->>'tipo';
    v_registrado_em := NULLIF(v_correcao.valor_proposto->>'registrado_em', '')::timestamptz;

    IF v_tipo IN ('entrada', 'saida_intervalo', 'retorno_intervalo', 'saida') AND v_registrado_em IS NOT NULL THEN
      INSERT INTO public.ponto_marcacoes (
        operacao_id, usuario_id, tipo, origem, registrado_em, dia_brt, origem_correcao_id, sinalizado_para_revisao
      ) VALUES (
        gen_random_uuid(), v_correcao.usuario_id, v_tipo, 'correcao', v_registrado_em,
        (v_registrado_em AT TIME ZONE 'America/Sao_Paulo')::date, v_correcao.id, false
      ) RETURNING id INTO v_nova_marcacao_id;

      UPDATE public.ponto_correcoes SET marcacao_gerada_id = v_nova_marcacao_id WHERE id = p_correcao_id;
    END IF;
  END IF;

  RETURN QUERY SELECT 'decidida_agora'::text, p_correcao_id, p_decisao, p_decisor_id, now(), v_nova_marcacao_id;
END;
$$ LANGUAGE plpgsql;

COMMIT;
