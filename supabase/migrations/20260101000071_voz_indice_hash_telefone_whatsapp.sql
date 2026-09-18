-- fn_hash_telefone chamava digest() sem qualificar o schema. Funciona numa
-- query normal (o search_path inclui "extensions"), mas QUEBRA na criacao de
-- indice de expressao, que roda com search_path restrito. Qualificar e o que
-- destrava o indice. O algoritmo e identico, entao nenhum hash ja gravado muda.
create or replace function public.fn_hash_telefone(numero text)
returns text
language sql
immutable
as $function$
  SELECT CASE WHEN x.d = '' THEN NULL
    ELSE encode(extensions.digest(
      CASE WHEN x.d LIKE '55%' AND length(x.d) IN (12, 13) THEN substr(x.d, 3) ELSE x.d END,
      'sha256'), 'hex')
  END
  FROM (SELECT regexp_replace(coalesce(numero, ''), '\D', '', 'g') AS d) x;
$function$;

-- A view da fila recalculava esse SHA-256 para cada mensagem recebida dos
-- ultimos 30 dias a CADA consulta: 16 mil linhas, ~9,9s de 11,5s totais.
-- Pesava na tela da Central de Voz E em toda rodada da fila de ligacao.
create index if not exists idx_whatsapp_msg_hash_entrada
  on public.whatsapp_mensagens (fn_hash_telefone(telefone), created_at)
  where direcao = 'entrada';
