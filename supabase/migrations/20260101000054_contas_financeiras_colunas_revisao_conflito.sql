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
-- Tipos CONFIRMADOS via consulta read-only a information_schema.columns
-- direto em produção (2026-09-11, nenhuma alteração aplicada) — não são
-- mais inferência (a suspeita inicial, por convenção do resto do schema,
-- bateu exatamente com o real):
--   conflito_baixa_legado   -> boolean, NOT NULL, default false
--   em_revisao_desde        -> timestamp with time zone, nullable, sem default
--   motivo_revisao          -> text, nullable, sem default
--   sincronizado_legado_em  -> timestamp with time zone, nullable, sem default
ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS motivo_revisao text,
  ADD COLUMN IF NOT EXISTS em_revisao_desde timestamptz,
  ADD COLUMN IF NOT EXISTS conflito_baixa_legado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sincronizado_legado_em timestamptz;
