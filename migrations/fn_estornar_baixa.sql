-- RPC atômica: estorna UMA baixa específica (nunca zera a conta inteira).
-- Abaixo do limite (p_limite_sem_aprovacao), conclui na hora. Acima, só cria a
-- solicitação em estornos_financeiros (status='pendente_aprovacao') — baixa e
-- conta continuam intocadas até fn_aprovar_estorno rodar.
CREATE OR REPLACE FUNCTION public.fn_estornar_baixa(
  p_baixa_id uuid,
  p_usuario_id uuid,
  p_motivo_categoria text,
  p_motivo_detalhado text,
  p_limite_sem_aprovacao numeric
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_baixa baixas_financeiras%ROWTYPE;
  v_conta contas_financeiras%ROWTYPE;
  v_valor_pago numeric;
  v_saldo numeric;
  v_status text;
  v_estorno_id uuid;
  v_precisa_aprovacao boolean;
  v_em_revisao boolean;
BEGIN
  IF p_motivo_detalhado IS NULL OR length(trim(p_motivo_detalhado)) = 0 THEN
    RAISE EXCEPTION 'Motivo detalhado é obrigatório';
  END IF;

  SELECT * INTO v_baixa FROM baixas_financeiras WHERE id = p_baixa_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Baixa não encontrada';
  END IF;
  IF v_baixa.status = 'estornada' THEN
    RAISE EXCEPTION 'Esta baixa já foi estornada';
  END IF;
  IF v_baixa.conciliado THEN
    RAISE EXCEPTION 'Esta baixa está conciliada em extrato bancário — não pode ser estornada diretamente. Solicite revisão ao financeiro.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM estornos_financeiros
    WHERE baixa_financeira_id = p_baixa_id AND status = 'pendente_aprovacao'
  ) THEN
    RAISE EXCEPTION 'Já existe uma solicitação de estorno pendente de aprovação para esta baixa';
  END IF;

  SELECT * INTO v_conta FROM contas_financeiras WHERE id = v_baixa.conta_financeira_id FOR UPDATE;
  IF v_conta.status = 'cancelada' THEN
    RAISE EXCEPTION 'Este título está cancelado';
  END IF;

  v_precisa_aprovacao := v_baixa.valor_baixado > p_limite_sem_aprovacao;
  v_em_revisao := p_motivo_categoria IN ('pagamento_nao_confirmado', 'devolucao_chargeback');

  IF v_precisa_aprovacao THEN
    INSERT INTO estornos_financeiros
      (baixa_financeira_id, conta_financeira_id, valor_estornado, motivo_categoria, motivo_detalhado, status, solicitado_por_usuario_id)
    VALUES
      (p_baixa_id, v_conta.id, v_baixa.valor_baixado, p_motivo_categoria, p_motivo_detalhado, 'pendente_aprovacao', p_usuario_id)
    RETURNING id INTO v_estorno_id;

    RETURN jsonb_build_object(
      'estorno_id', v_estorno_id,
      'status', 'pendente_aprovacao',
      'precisa_aprovacao', true,
      'conta_id', v_conta.id,
      'saldo', v_conta.valor - v_conta.valor_pago
    );
  END IF;

  UPDATE baixas_financeiras
  SET status = 'estornada',
      estornado_em = now(),
      estornado_por_usuario_id = p_usuario_id,
      motivo_estorno_categoria = p_motivo_categoria,
      motivo_estorno_detalhado = p_motivo_detalhado,
      updated_at = now()
  WHERE id = p_baixa_id;

  SELECT COALESCE(SUM(valor_baixado), 0) INTO v_valor_pago
  FROM baixas_financeiras WHERE conta_financeira_id = v_conta.id AND status = 'ativa';

  v_saldo := v_conta.valor - v_valor_pago;

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

  INSERT INTO estornos_financeiros
    (baixa_financeira_id, conta_financeira_id, valor_estornado, motivo_categoria, motivo_detalhado, status, solicitado_por_usuario_id)
  VALUES
    (p_baixa_id, v_conta.id, v_baixa.valor_baixado, p_motivo_categoria, p_motivo_detalhado, 'concluido', p_usuario_id)
  RETURNING id INTO v_estorno_id;

  RETURN jsonb_build_object(
    'estorno_id', v_estorno_id,
    'status', 'concluido',
    'precisa_aprovacao', false,
    'conta_id', v_conta.id,
    'valor_pago', v_valor_pago,
    'saldo', v_saldo,
    'status_conta', v_status,
    'em_revisao_financeira', v_em_revisao
  );
END;
$$;
