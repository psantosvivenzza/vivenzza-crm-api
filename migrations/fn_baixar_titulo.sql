-- RPC atômica: cria uma baixa individual e recalcula contas_financeiras a
-- partir da soma de baixas ativas. SELECT ... FOR UPDATE trava a conta contra
-- baixas concorrentes no mesmo título (clique duplo, duas abas).
--
-- Nota de dívida técnica corrigida: as RPCs já existentes no projeto (ex:
-- proximo_vendedor_atomic, get_ultima_mensagem_por_lead) nunca foram
-- versionadas em migrations/ — foram criadas direto no Supabase SQL Editor.
-- Esta e as próximas 3 funções (fn_estornar_baixa, fn_aprovar_estorno,
-- fn_rejeitar_estorno) ficam no repositório desde o início.
CREATE OR REPLACE FUNCTION public.fn_baixar_titulo(
  p_conta_id uuid,
  p_valor numeric,
  p_data_pagamento date,
  p_forma_pagamento text,
  p_observacao text,
  p_usuario_id uuid,
  p_origem text DEFAULT 'manual'
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_conta contas_financeiras%ROWTYPE;
  v_baixa_id uuid;
  v_valor_pago numeric;
  v_saldo numeric;
  v_status text;
BEGIN
  IF p_valor IS NULL OR p_valor <= 0 THEN
    RAISE EXCEPTION 'valor deve ser maior que zero';
  END IF;

  SELECT * INTO v_conta FROM contas_financeiras WHERE id = p_conta_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conta não encontrada';
  END IF;
  IF v_conta.status = 'paga' THEN
    RAISE EXCEPTION 'Este título já está totalmente pago';
  END IF;
  IF v_conta.status = 'cancelada' THEN
    RAISE EXCEPTION 'Este título está cancelado';
  END IF;

  INSERT INTO baixas_financeiras
    (conta_financeira_id, valor_baixado, data_pagamento, forma_pagamento, observacao, origem, status, criado_por_usuario_id)
  VALUES
    (p_conta_id, p_valor, p_data_pagamento, p_forma_pagamento, p_observacao, p_origem, 'ativa', p_usuario_id)
  RETURNING id INTO v_baixa_id;

  SELECT COALESCE(SUM(valor_baixado), 0) INTO v_valor_pago
  FROM baixas_financeiras WHERE conta_financeira_id = p_conta_id AND status = 'ativa';

  v_saldo := v_conta.valor - v_valor_pago;

  -- Ordem importa: saldo zerado sempre vence; entre os que restam, "pago
  -- parcialmente" tem prioridade sobre "vencida" (um título com baixa parcial
  -- e já vencido é pago_parcial, não vencida).
  IF v_saldo <= 0 THEN
    v_status := 'paga';
  ELSIF v_valor_pago > 0 THEN
    v_status := 'pago_parcial';
  ELSIF v_conta.vencimento < CURRENT_DATE THEN
    v_status := 'vencida';
  ELSE
    v_status := 'aberta';
  END IF;

  UPDATE contas_financeiras
  SET valor_pago = v_valor_pago,
      status = v_status,
      data_pagamento = p_data_pagamento,
      forma_pagamento = p_forma_pagamento,
      observacao_pagamento = p_observacao,
      updated_at = now()
  WHERE id = p_conta_id;

  RETURN jsonb_build_object(
    'baixa_id', v_baixa_id,
    'conta_id', p_conta_id,
    'valor_pago', v_valor_pago,
    'saldo', v_saldo,
    'status', v_status
  );
END;
$$;
