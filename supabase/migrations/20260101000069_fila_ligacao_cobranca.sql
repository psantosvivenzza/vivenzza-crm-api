-- FASE 4 (2026-09-17) — a ligação deixa de ser disparo avulso e vira etapa da
-- régua: só liga para quem já recebeu WhatsApp há mais de 2 dias e NÃO
-- respondeu. Nada aqui dispara nada — é só a lista. Quem disca continua
-- passando pelos guards de reguaTentativas.js; esta view é a PRIMEIRA
-- peneira, não a única.

-- Normalização idêntica à de reguaTentativas.hashTelefone() no Node. As duas
-- TÊM que concordar, senão a contagem de tentativas por cliente se perde.
-- Conferido: '51991567661' -> 38ddaee43b6d... nos dois lados.
CREATE OR REPLACE FUNCTION public.fn_hash_telefone(numero text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN x.d = '' THEN NULL
    ELSE encode(digest(
      CASE WHEN x.d LIKE '55%' AND length(x.d) IN (12, 13) THEN substr(x.d, 3) ELSE x.d END,
      'sha256'), 'hex')
  END
  FROM (SELECT regexp_replace(coalesce(numero, ''), '\D', '', 'g') AS d) x;
$$;

COMMENT ON FUNCTION public.fn_hash_telefone(text) IS
  'SHA-256 do telefone normalizado (sem pontuação, sem DDI 55). Espelha reguaTentativas.hashTelefone() no Node — as duas precisam concordar.';

CREATE OR REPLACE VIEW public.vw_fila_ligacao_cobranca AS
WITH titulos AS (
  SELECT
    cf.codigo_cliente,
    max(cf.pessoa_nome)               AS cliente,
    max(cf.telefone_cobranca)         AS telefone,
    count(*)                          AS titulos,
    sum(cf.valor)                     AS valor_total,
    max(current_date - cf.vencimento) AS dias_atraso_max,
    min(cf.vencimento)                AS vencimento_mais_antigo
  FROM public.contas_financeiras cf
  WHERE cf.tipo ILIKE '%receb%'
    AND cf.status IN ('vencida', 'aberta')
    AND cf.vencimento < current_date
    AND NOT coalesce(cf.em_revisao, false)
    AND NOT coalesce(cf.em_revisao_financeira, false)
    AND cf.telefone_cobranca IS NOT NULL AND cf.telefone_cobranca <> ''
    AND cf.codigo_cliente IS NOT NULL
  GROUP BY cf.codigo_cliente
),
base AS (SELECT t.*, public.fn_hash_telefone(t.telefone) AS telefone_hash FROM titulos t),
zap AS (
  SELECT public.fn_hash_telefone(cw.cliente_telefone) AS telefone_hash,
         max(cw.data_envio) AS ultimo_envio, max(cw.etapa) AS ultima_etapa
  FROM public.cobrancas_whatsapp cw GROUP BY 1
),
respostas AS (
  -- Resposta REAL do cliente, lida de whatsapp_mensagens (direção entrada) e
  -- NÃO de cobrancas_whatsapp.data_resposta, que só captura uma fração das
  -- respostas (17 respostas reais, 1 registrada — medido em 17/09/2026).
  SELECT public.fn_hash_telefone(m.telefone) AS telefone_hash,
         max(m.created_at) AS ultima_resposta
  FROM public.whatsapp_mensagens m
  WHERE m.direcao = 'entrada' AND m.created_at >= now() - interval '30 days'
  GROUP BY 1
),
voz AS (
  SELECT v.telefone_hash,
    max(v.criado_em) AS ultima_ligacao,
    max(v.ciclo_iniciado_em) AS ciclo_atual,
    count(*) FILTER (WHERE v.ciclo_iniciado_em = (
      SELECT max(v2.ciclo_iniciado_em) FROM public.voice_calls v2
      WHERE v2.telefone_hash = v.telefone_hash)) AS tentativas_ciclo,
    max(v.answered_at) AS ultimo_atendimento,
    max(v.data_prometida) AS promessa_ate
  FROM public.voice_calls v
  WHERE v.destination_type = 'EXTERNAL'
  GROUP BY v.telefone_hash
)
SELECT
  b.codigo_cliente, b.cliente, b.telefone,
  '****' || right(regexp_replace(b.telefone, '\D', '', 'g'), 4) AS telefone_mascarado,
  b.titulos, round(b.valor_total, 2) AS valor_total,
  b.dias_atraso_max, b.vencimento_mais_antigo,
  CASE WHEN b.dias_atraso_max <= 90 THEN 'A. ate 90 dias'
       WHEN b.dias_atraso_max <= 365 THEN 'B. 91-365 dias'
       ELSE 'C. mais de 1 ano' END AS faixa,
  CASE WHEN b.dias_atraso_max <= 90 THEN 1
       WHEN b.dias_atraso_max <= 365 THEN 2
       ELSE 3 END AS prioridade,
  z.ultimo_envio AS whatsapp_enviado_em,
  z.ultima_etapa AS whatsapp_etapa,
  r.ultima_resposta AS respondeu_whatsapp_em,
  vz.ultima_ligacao,
  coalesce(vz.tentativas_ciclo, 0) AS tentativas_ciclo,
  vz.promessa_ate,
  CASE
    WHEN r.ultima_resposta IS NOT NULL THEN 'respondeu_whatsapp'
    WHEN vz.promessa_ate IS NOT NULL AND vz.promessa_ate >= current_date THEN 'promessa_em_aberto'
    WHEN vz.ultimo_atendimento IS NOT NULL AND vz.ultimo_atendimento >= now() - interval '7 days' THEN 'trava_pos_contato'
    WHEN coalesce(vz.tentativas_ciclo, 0) >= 10 THEN 'ciclo_esgotado'
    WHEN vz.ultima_ligacao IS NOT NULL
      AND (vz.ultima_ligacao AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
      THEN 'ja_ligou_hoje'
    WHEN z.ultimo_envio IS NULL THEN 'sem_whatsapp_ainda'
    WHEN z.ultimo_envio > now() - interval '2 days' THEN 'aguardando_resposta_do_whatsapp'
    ELSE NULL
  END AS motivo_bloqueio
FROM base b
LEFT JOIN zap z ON z.telefone_hash = b.telefone_hash
LEFT JOIN respostas r ON r.telefone_hash = b.telefone_hash
LEFT JOIN voz vz ON vz.telefone_hash = b.telefone_hash
ORDER BY prioridade, b.valor_total DESC;

COMMENT ON VIEW public.vw_fila_ligacao_cobranca IS
  'Fila diária de ligação de cobrança. motivo_bloqueio NULL = elegível hoje. Voz é ESCALONAMENTO: só entra na fila quem já recebeu WhatsApp há mais de 2 dias e não respondeu.';
