-- 2026-09-17 — views da Central de Voz no ERP.
-- Mantidas no banco (e não em SQL espalhado no front) para que a definição de
-- cada métrica exista em UM lugar só: taxa de atendimento e duração média são
-- alarme de bloqueio de operadora, não podem divergir entre telas.

CREATE OR REPLACE VIEW public.vw_voice_operacao_dia AS
SELECT
  (criado_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia,
  count(*)                                              AS disparadas,
  count(*) FILTER (WHERE answered_at IS NOT NULL)       AS atendidas,
  count(*) FILTER (WHERE status IN ('NO_ANSWER','BUSY','CANCELLED'))  AS sem_atendimento,
  count(*) FILTER (WHERE status = 'FAILED')             AS falhas,
  count(*) FILTER (WHERE requires_human)                AS transbordos,
  count(*) FILTER (WHERE data_prometida IS NOT NULL)    AS promessas,
  coalesce(sum(valor_prometido), 0)                     AS valor_prometido,
  round(avg(duration_seconds) FILTER (WHERE answered_at IS NOT NULL), 1) AS duracao_media_s,
  round(100.0 * count(*) FILTER (WHERE answered_at IS NOT NULL) / nullif(count(*), 0), 1) AS taxa_atendimento_pct
FROM public.voice_calls
WHERE destination_type = 'EXTERNAL'
GROUP BY 1
ORDER BY 1 DESC;

CREATE OR REPLACE VIEW public.vw_voice_chamadas_detalhe AS
SELECT
  v.id, v.call_id,
  (v.criado_em AT TIME ZONE 'America/Sao_Paulo')  AS quando_brt,
  v.codigo_cliente,
  coalesce(v.cliente_nome, cf.pessoa_nome)        AS cliente,
  v.destination_masked                            AS telefone_mascarado,
  v.faixa_horario, v.tentativa_numero, v.ciclo_iniciado_em, v.status,
  (v.answered_at IS NOT NULL)                     AS atendida,
  v.duration_seconds,
  v.intent_final                                  AS desfecho,
  v.requires_human                                AS pediu_humano,
  v.valor_prometido, v.data_prometida, v.failure_class, v.hangup_cause,
  v.gravacao_path, v.campanha
FROM public.voice_calls v
LEFT JOIN public.contas_financeiras cf ON cf.id = v.conta_id
WHERE v.destination_type = 'EXTERNAL'
ORDER BY v.criado_em DESC;

CREATE OR REPLACE VIEW public.vw_voice_saude_ia AS
SELECT
  count(*) FILTER (WHERE answered_at IS NOT NULL)  AS atendidas,
  count(*) FILTER (WHERE requires_human)           AS transbordos,
  round(100.0 * (1 - (count(*) FILTER (WHERE requires_human)::numeric
    / nullif(count(*) FILTER (WHERE answered_at IS NOT NULL), 0))), 1) AS contencao_pct,
  round(avg(duration_seconds) FILTER (WHERE answered_at IS NOT NULL), 1) AS duracao_media_s,
  count(*) FILTER (WHERE intent_final IS NULL AND answered_at IS NOT NULL) AS sem_intencao_detectada
FROM public.voice_calls
WHERE destination_type = 'EXTERNAL' AND criado_em >= now() - interval '30 days';

-- Qual faixa de horário realmente atende. É este número que vai dizer, com
-- evidência e não com palpite, o melhor horário para falar com salão e
-- distribuidor (a literatura de cobrança é toda de consumidor final).
CREATE OR REPLACE VIEW public.vw_voice_atendimento_por_faixa AS
SELECT
  coalesce(faixa_horario, 'FORA_DE_FAIXA') AS faixa,
  count(*)                                 AS disparadas,
  count(*) FILTER (WHERE answered_at IS NOT NULL) AS atendidas,
  round(100.0 * count(*) FILTER (WHERE answered_at IS NOT NULL) / nullif(count(*), 0), 1) AS taxa_atendimento_pct
FROM public.voice_calls
WHERE destination_type = 'EXTERNAL'
GROUP BY 1
ORDER BY taxa_atendimento_pct DESC NULLS LAST;

-- Semáforo de risco. Os limiares (15% de atendimento, 40s de duração) são os
-- sinais de que a operadora começou a bloquear o número.
CREATE OR REPLACE VIEW public.vw_voice_risco AS
WITH janela AS (
  SELECT * FROM public.voice_calls
  WHERE destination_type = 'EXTERNAL' AND criado_em >= now() - interval '7 days'
)
SELECT
  count(*) AS chamadas_7d,
  round(100.0 * count(*) FILTER (WHERE answered_at IS NOT NULL) / nullif(count(*), 0), 1) AS taxa_atendimento_pct,
  round(avg(duration_seconds) FILTER (WHERE answered_at IS NOT NULL), 1) AS duracao_media_s,
  (count(*) >= 20 AND 100.0 * count(*) FILTER (WHERE answered_at IS NOT NULL) / nullif(count(*), 0) < 15) AS alerta_possivel_bloqueio_operadora,
  (count(*) >= 20 AND avg(duration_seconds) FILTER (WHERE answered_at IS NOT NULL) < 40) AS alerta_duracao_baixa,
  (SELECT count(*) FROM (
      SELECT telefone_hash FROM janela WHERE telefone_hash IS NOT NULL
      GROUP BY telefone_hash HAVING count(*) >= 10
   ) t) AS clientes_no_teto_de_tentativas
FROM janela;

-- Este número deve ser SEMPRE zero. Se não for, é bug de fuso horário, não
-- exceção de negócio.
CREATE OR REPLACE VIEW public.vw_voice_fora_da_janela_legal AS
SELECT
  v.call_id,
  (v.criado_em AT TIME ZONE 'America/Sao_Paulo') AS quando_brt,
  v.destination_masked, v.campanha
FROM public.voice_calls v
WHERE v.destination_type = 'EXTERNAL'
  AND (
    extract(isodow FROM (v.criado_em AT TIME ZONE 'America/Sao_Paulo')) > 5
    OR (v.criado_em AT TIME ZONE 'America/Sao_Paulo')::time < time '08:00'
    OR (v.criado_em AT TIME ZONE 'America/Sao_Paulo')::time >= time '18:40'
  )
ORDER BY v.criado_em DESC;
