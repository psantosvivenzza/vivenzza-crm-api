-- RPC atômica: rejeita um estorno pendente. Baixa e conta permanecem
-- intocadas — só o registro de estorno muda de status, com motivo obrigatório.
CREATE OR REPLACE FUNCTION public.fn_rejeitar_estorno(
  p_estorno_id uuid,
  p_usuario_id uuid,
  p_motivo_rejeicao text
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_estorno estornos_financeiros%ROWTYPE;
BEGIN
  IF p_motivo_rejeicao IS NULL OR length(trim(p_motivo_rejeicao)) = 0 THEN
    RAISE EXCEPTION 'Motivo da rejeição é obrigatório';
  END IF;

  SELECT * INTO v_estorno FROM estornos_financeiros WHERE id = p_estorno_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Estorno não encontrado';
  END IF;
  IF v_estorno.status <> 'pendente_aprovacao' THEN
    RAISE EXCEPTION 'Este estorno não está pendente de aprovação';
  END IF;
  IF v_estorno.solicitado_por_usuario_id = p_usuario_id THEN
    RAISE EXCEPTION 'Quem solicitou o estorno não pode rejeitá-lo';
  END IF;

  UPDATE estornos_financeiros
  SET status = 'rejeitado',
      rejeitado_por_usuario_id = p_usuario_id,
      rejeitado_em = now(),
      motivo_rejeicao = p_motivo_rejeicao,
      updated_at = now()
  WHERE id = p_estorno_id;

  RETURN jsonb_build_object('estorno_id', p_estorno_id, 'status', 'rejeitado');
END;
$$;
