-- RPC atômica: aprova um estorno pendente. Quem solicitou não pode aprovar
-- (separação de responsabilidade) — só aqui a baixa/conta são de fato alteradas
-- quando o estorno exigiu aprovação.
CREATE OR REPLACE FUNCTION public.fn_aprovar_estorno(
  p_estorno_id uuid,
  p_usuario_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_estorno estornos_financeiros%ROWTYPE;
  v_baixa baixas_financeiras%ROWTYPE;
  v_conta contas_financeiras%ROWTYPE;
  v_valor_pago numeric;
  v_saldo numeric;
  v_status text;
  v_em_revisao boolean;
BEGIN
  SELECT * INTO v_estorno FROM estornos_financeiros WHERE id = p_estorno_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estorno não encontrado';
  END IF;
  IF v_estorno.status <> 'pendente_aprovacao' THEN
    RAISE EXCEPTION 'Este estorno não está pendente de aprovação';
  END IF;
  IF v_estorno.solicitado_por_usuario_id = p_usuario_id THEN
    RAISE EXCEPTION 'Quem solicitou o estorno não pode aprová-lo';
  END IF;

  SELECT * INTO v_baixa FROM baixas_financeiras WHERE id = v_estorno.baixa_financeira_id FOR UPDATE;
  IF v_baixa.status = 'estornada' THEN
    RAISE EXCEPTION 'Esta baixa já foi estornada';
  END IF;

  SELECT * INTO v_conta FROM contas_financeiras WHERE id = v_estorno.conta_financeira_id FOR UPDATE;

  UPDATE baixas_financeiras
  SET status = 'estornada',
      estornado_em = now(),
      estornado_por_usuario_id = p_usuario_id,
      motivo_estorno_categoria = v_estorno.motivo_categoria,
      motivo_estorno_detalhado = v_estorno.motivo_detalhado,
      updated_at = now()
  WHERE id = v_baixa.id;

  SELECT COALESCE(SUM(valor_baixado), 0) INTO v_valor_pago
  FROM baixas_financeiras WHERE conta_financeira_id = v_conta.id AND status = 'ativa';

  v_saldo := v_conta.valor - v_valor_pago;
  v_em_revisao := v_estorno.motivo_categoria IN ('pagamento_nao_confirmado', 'devolucao_chargeback');

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
      em_revisao_financeira = CASE WHEN v_em_revisao THEN true ELSE em_revisao_financeira END,
      updated_at = now()
  WHERE id = v_conta.id;

  UPDATE estornos_financeiros
  SET status = 'concluido',
      aprovado_por_usuario_id = p_usuario_id,
      aprovado_em = now(),
      updated_at = now()
  WHERE id = p_estorno_id;

  RETURN jsonb_build_object(
    'estorno_id', p_estorno_id,
    'status', 'concluido',
    'conta_id', v_conta.id,
    'valor_pago', v_valor_pago,
    'saldo', v_saldo,
    'status_conta', v_status,
    'em_revisao_financeira', v_em_revisao
  );
END;
$$;
