-- Achado (2026-09-11, ao versionar fn_sincronizar_baixa_legado a partir da
-- definição real capturada em produção via pg_get_functiondef/pg_proc):
-- a função usa contas_financeiras.motivo_revisao, .em_revisao_desde,
-- .conflito_baixa_legado e .sincronizado_legado_em (lendo/zerando os dois
-- primeiros, escrevendo boolean no terceiro, escrevendo now() no quarto a
-- cada chamada) mas nenhuma migration commitada cria essas 4 colunas —
-- mesmo padrão de drift já visto em 20260101000045 (valor_pago_legado): só
-- existem no schema live de produção. ADD COLUMN IF NOT EXISTS é no-op lá;
-- só passa a existir em ambientes novos (local/CI), que precisam delas pra
-- rodar fn_sincronizar_baixa_legado (ver
-- 20260101000055_fn_sincronizar_baixa_legado.sql) de ponta a ponta nos
-- testes. sincronizado_legado_em em particular já é lida por scripts reais
-- (scripts/analise-duplicados-financeiro.mjs,
-- scripts/preview-duplicados-financeiro.mjs) e escrita também na criação de
-- título em src/jobs/sync-financeiro-legado.js — confirmado ali como
-- timestamp (new Date().toISOString()), não é inferência.
--
-- Tipos de motivo_revisao (text) e em_revisao_desde (timestamptz) são
-- inferidos por convenção do restante do schema (par com
-- em_revisao_financeira boolean já existente, e o mesmo padrão de
-- baixas_financeiras.motivo_estorno_categoria/detalhado text +
-- estornado_em timestamptz) — a função só os zera (SET ... = NULL) nesta
-- rodada, nunca escreve um valor não-nulo neles, então não força um tipo
-- específico na compilação do plpgsql (CREATE FUNCTION com plpgsql não
-- valida semântica de SQL embutido — só a 1ª execução real teria acusado
-- tipo incompatível, e a suíte local em
-- fn-sincronizar-baixa-legado.test.mjs passou com estes tipos). Já
-- conflito_baixa_legado é boolean com certeza: a função atribui a variável
-- plpgsql `v_conflito boolean` direto pra essa coluna. Se a inspeção real
-- do schema de produção (information_schema.columns) mostrar tipo
-- diferente pra motivo_revisao/em_revisao_desde, ajustar aqui antes de
-- tratar esta migration como definitiva.
ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS motivo_revisao text,
  ADD COLUMN IF NOT EXISTS em_revisao_desde timestamptz,
  ADD COLUMN IF NOT EXISTS conflito_baixa_legado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sincronizado_legado_em timestamptz;
