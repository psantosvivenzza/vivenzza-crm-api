-- Separa "pausar recebimento de leads" de "bloquear acesso ao CRM".
-- Até aqui os dois efeitos eram o mesmo campo `ativo`, usado tanto pra
-- login quanto pelo filtro do rodízio de leads — não dava pra pausar uma
-- vendedora do rodízio sem também derrubar o login dela.
--
-- Esta migration também é a PRIMEIRA vez que proximo_vendedor_atomic() é
-- versionada em migrations/ — até agora ela só existia live no Supabase
-- SQL Editor (achado da auditoria, ver 20260101000003_fn_baixar_titulo.sql).
-- A definição abaixo reproduz fielmente a lógica em produção (lock FOR
-- UPDATE em distribuicao_leads.id=1, avanço circular por ordem alfabética
-- de nome), só adicionando o filtro recebe_leads = true.

ALTER TABLE public.usuarios
  ADD COLUMN IF NOT EXISTS recebe_leads boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.usuarios.recebe_leads IS
  'Elegibilidade pro rodízio automático de leads (proximo_vendedor_atomic). Independente de `ativo`: uma vendedora pode manter login no CRM e ficar temporariamente fora do rodízio.';

CREATE OR REPLACE FUNCTION public.proximo_vendedor_atomic()
 RETURNS TABLE(id uuid, nome text)
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_id uuid; v_nome text; v_ultimo uuid; v_idx integer; v_total integer; v_ids uuid[];
BEGIN
  -- Lock exclusivo na linha de distribuição (evita race condition entre chamadas concorrentes)
  SELECT ultimo_vendedor_id INTO v_ultimo
  FROM distribuicao_leads WHERE distribuicao_leads.id = 1
  FOR UPDATE;

  SELECT array_agg(u.id ORDER BY u.nome), count(*)
  INTO v_ids, v_total
  FROM usuarios u
  WHERE u.role = 'vendedor' AND u.ativo = true AND u.recebe_leads = true;

  IF v_total = 0 THEN RETURN; END IF;

  -- avança circularmente a partir do último vendedor sorteado
  v_idx := 0;
  FOR i IN 1..v_total LOOP
    IF v_ids[i] = v_ultimo THEN v_idx := i; END IF;
  END LOOP;
  v_id := v_ids[(v_idx % v_total) + 1];

  SELECT u.nome INTO v_nome FROM usuarios u WHERE u.id = v_id;

  UPDATE distribuicao_leads SET ultimo_vendedor_id = v_id, updated_at = now() WHERE distribuicao_leads.id = 1;

  RETURN QUERY SELECT v_id, v_nome;
END;
$function$;
