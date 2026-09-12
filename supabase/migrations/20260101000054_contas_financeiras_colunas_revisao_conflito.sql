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
--
-- ACHADO (revisão independente, 2026-09-12, ao integrar esta PR com #79/#80
-- pra checagem cruzada de dependências de migration): fn_sincronizar_baixa_legado
-- (20260101000055) também lê e escreve contas_financeiras.em_revisao_financeira
-- (linhas "em_revisao_financeira = false" no branch de cancelamento e
-- "v_revisao_resolvida := (v_conta.em_revisao_financeira AND v_status = 'paga')"
-- no fluxo principal) — mas essa coluna só tinha migration própria na PR #79
-- (20260101000063_contas_financeiras_em_revisao_financeira.sql), não aqui.
-- Reproduzido: aplicar só as migrations desta PR (054-056) contra uma base
-- sem o drift de produção faz `CREATE OR REPLACE FUNCTION` em 000055 passar
-- silenciosamente (PL/pgSQL não valida coluna referenciada em SQL embutido no
-- momento da criação da function), mas a PRIMEIRA chamada real de
-- fn_sincronizar_baixa_legado falha em runtime com `record "v_conta" has no
-- field "em_revisao_financeira"` — ou seja, esta PR não é auto-suficiente:
-- depende de uma migration de outra PR pra não quebrar em qualquer ambiente
-- novo (Supabase novo, staging, CI) que não tenha o drift de produção. Mesmo
-- tipo/default de 20260101000063 (boolean NOT NULL DEFAULT false) — ADD
-- COLUMN IF NOT EXISTS torna esta linha um no-op seguro caso a 000063 da PR
-- #79 já tenha rodado antes (ou depois) desta, em qualquer ordem de merge.
ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS motivo_revisao text,
  ADD COLUMN IF NOT EXISTS em_revisao_desde timestamptz,
  ADD COLUMN IF NOT EXISTS conflito_baixa_legado boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sincronizado_legado_em timestamptz,
  ADD COLUMN IF NOT EXISTS em_revisao_financeira boolean NOT NULL DEFAULT false;
