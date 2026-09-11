-- Achado (2026-09-11): fn_sincronizar_baixa_legado é chamada por
-- src/jobs/sync-financeiro-legado.js (RPC 'fn_sincronizar_baixa_legado') pra
-- atualizar títulos existentes a partir do NetVision — cancelamento,
-- encerramento, resolução de em_revisao_financeira — mas nunca teve
-- migration correspondente em supabase/migrations/ nem migrations/: existe
-- só no schema live do Supabase, aplicada manualmente em algum momento não
-- auditável via git log/git blame (ver docs/claude-context/tarefas-pendentes.md,
-- seção "Financeiro — RPC não versionada"). Depende das colunas adicionadas
-- em 20260101000047_contas_financeiras_colunas_revisao_conflito.sql.
--
-- Corpo abaixo é cópia FIEL de pg_get_functiondef(oid) rodado contra o
-- Postgres real de produção em 2026-09-11 (consulta read-only via pg_proc,
-- nenhuma alteração aplicada em produção nesta rodada) — nenhuma linha
-- reescrita ou "melhorada". CREATE OR REPLACE é no-op em produção (mesmo
-- corpo); só passa a existir em ambientes novos (local/CI), que precisam
-- dela pra rodar sync-financeiro-legado.js de ponta a ponta nos testes.
--
-- Comportamento documentado no chamador (sync-financeiro-legado.js) e
-- preservado aqui sem alteração: idempotente (rodar N vezes = mesmo
-- estado), nunca reverte pagamento (valor "menor" do legado vira conflito
-- sinalizado, não estorno automático), nunca duplica dinheiro (baixa manual
-- já lançada no CRM é descontada do que este sync espelha).
CREATE OR REPLACE FUNCTION public.fn_sincronizar_baixa_legado(p_conta_id uuid, p_valor_pago_legado numeric, p_data_pagamento date, p_referencia text DEFAULT NULL::text, p_cancelado_no_legado boolean DEFAULT false, p_encerrado_no_legado boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_conta contas_financeiras%ROWTYPE;
  v_outras numeric;
  v_alvo_sync numeric;
  v_baixa_sync baixas_financeiras%ROWTYPE;
  v_valor_pago numeric;
  v_saldo numeric;
  v_status text;
  v_acao text := 'nenhuma';
  v_conflito boolean := false;
  v_revisao_resolvida boolean := false;
  v_encerrado_com_saldo boolean := false;
  v_observacao text;
BEGIN
  SELECT * INTO v_conta FROM contas_financeiras WHERE id = p_conta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conta não encontrada: %', p_conta_id;
  END IF;

  IF p_cancelado_no_legado THEN
    IF v_conta.status IS DISTINCT FROM 'cancelada' THEN
      UPDATE contas_financeiras
      SET status = 'cancelada',
          em_revisao_financeira = false,
          motivo_revisao = NULL,
          em_revisao_desde = NULL,
          sincronizado_legado_em = now(),
          updated_at = now()
      WHERE id = p_conta_id;
      v_acao := 'cancelado';
      v_revisao_resolvida := v_conta.em_revisao_financeira;
    END IF;
    RETURN jsonb_build_object(
      'acao', v_acao, 'status', 'cancelada', 'conta_id', p_conta_id,
      'revisao_resolvida', v_revisao_resolvida
    );
  END IF;

  p_valor_pago_legado := GREATEST(COALESCE(p_valor_pago_legado, 0), 0);

  SELECT COALESCE(SUM(valor_baixado), 0) INTO v_outras
  FROM baixas_financeiras
  WHERE conta_financeira_id = p_conta_id AND status = 'ativa' AND origem <> 'sync_legado';

  SELECT * INTO v_baixa_sync
  FROM baixas_financeiras
  WHERE conta_financeira_id = p_conta_id AND status = 'ativa' AND origem = 'sync_legado'
  LIMIT 1;

  v_alvo_sync := GREATEST(p_valor_pago_legado - v_outras, 0);

  IF v_alvo_sync > 0 THEN
    IF v_baixa_sync.id IS NULL THEN
      INSERT INTO baixas_financeiras
        (conta_financeira_id, valor_baixado, data_pagamento, forma_pagamento, observacao, origem, status)
      VALUES
        (p_conta_id, v_alvo_sync, COALESCE(p_data_pagamento, CURRENT_DATE), 'erp_netvision',
         COALESCE('Baixa espelhada do NetVision — ' || p_referencia, 'Baixa espelhada do NetVision'),
         'sync_legado', 'ativa');
      v_acao := 'criada';
    ELSIF v_baixa_sync.valor_baixado < v_alvo_sync THEN
      UPDATE baixas_financeiras
      SET valor_baixado = v_alvo_sync,
          data_pagamento = COALESCE(p_data_pagamento, data_pagamento),
          updated_at = now()
      WHERE id = v_baixa_sync.id;
      v_acao := 'aumentada';
    ELSIF v_baixa_sync.valor_baixado > v_alvo_sync THEN
      v_conflito := true;
    END IF;
  ELSIF v_baixa_sync.id IS NOT NULL AND v_baixa_sync.valor_baixado > 0 THEN
    v_conflito := true;
  END IF;

  SELECT COALESCE(SUM(valor_baixado), 0) INTO v_valor_pago
  FROM baixas_financeiras WHERE conta_financeira_id = p_conta_id AND status = 'ativa';

  v_saldo := v_conta.valor - v_valor_pago;

  IF v_saldo <= 0.005 THEN
    v_status := 'paga';
  ELSIF v_valor_pago > 0 THEN
    v_status := 'pago_parcial';
  ELSIF v_conta.vencimento < CURRENT_DATE THEN
    v_status := 'vencida';
  ELSE
    v_status := 'aberta';
  END IF;

  IF p_encerrado_no_legado AND v_status <> 'paga' THEN
    v_encerrado_com_saldo := true;
    v_status := 'paga';
    v_observacao := format(
      'Encerrado no NetVision com saldo de R$ %s não recebido (acordo/desconto/baixa comercial). Valor efetivamente recebido: R$ %s.',
      to_char(v_saldo, 'FM999999990.00'), to_char(v_valor_pago, 'FM999999990.00')
    );
  END IF;

  IF v_conta.status = 'paga' AND v_status <> 'paga' THEN
    v_status := 'paga';
    v_conflito := true;
  END IF;

  v_revisao_resolvida := (v_conta.em_revisao_financeira AND v_status = 'paga');

  UPDATE contas_financeiras
  SET valor_pago = v_valor_pago,
      valor_pago_legado = p_valor_pago_legado,
      status = v_status,
      data_pagamento = COALESCE(p_data_pagamento, data_pagamento),
      observacao_pagamento = COALESCE(v_observacao, observacao_pagamento),
      conflito_baixa_legado = v_conflito,
      em_revisao_financeira = CASE WHEN v_status = 'paga' THEN false ELSE em_revisao_financeira END,
      motivo_revisao        = CASE WHEN v_status = 'paga' THEN NULL  ELSE motivo_revisao END,
      em_revisao_desde      = CASE WHEN v_status = 'paga' THEN NULL  ELSE em_revisao_desde END,
      sincronizado_legado_em = now(),
      updated_at = now()
  WHERE id = p_conta_id;

  RETURN jsonb_build_object(
    'acao', v_acao, 'conta_id', p_conta_id, 'valor_pago', v_valor_pago,
    'valor_pago_legado', p_valor_pago_legado, 'saldo', v_saldo,
    'status', v_status, 'conflito', v_conflito,
    'revisao_resolvida', v_revisao_resolvida,
    'encerrado_com_saldo', v_encerrado_com_saldo
  );
END;
$function$
