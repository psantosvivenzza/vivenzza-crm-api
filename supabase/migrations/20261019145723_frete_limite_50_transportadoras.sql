-- Versão gerada pelo aplicador Supabase em produção: 20261019145723.
-- Autorização humana: até 50 transportadoras por cotação, não 50 envios simultâneos.
-- Não altera dados, fila ou cotas WhatsApp. Executar em transação única.
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';
DO $patch$
DECLARE
  definition text := pg_get_functiondef('public.frete_criar_cotacao(jsonb,uuid[],text)'::regprocedure);
  old_limit constant text := 'cardinality(p_ids) not between 1 and 30';
  new_limit constant text := 'cardinality(p_ids) not between 1 and 50';
BEGIN
  IF strpos(definition, old_limit) > 0 THEN
    IF array_length(string_to_array(definition, old_limit), 1) <> 2 THEN
      RAISE EXCEPTION 'Guarda de transportadoras ambígua; revisar antes de aplicar.';
    END IF;
    -- CREATE OR REPLACE preserva assinatura, proprietário e permissões existentes.
    -- O corpo atual é mantido integralmente, exceto pelo teto confirmado acima.
    EXECUTE replace(definition, old_limit, new_limit);
  ELSIF strpos(definition, new_limit) = 0 THEN
    RAISE EXCEPTION 'Guarda esperada não encontrada; nenhuma alteração aplicada.';
  END IF;
END $patch$;
