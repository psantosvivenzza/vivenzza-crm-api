-- NF-e série 99 (Nota Interna) — coluna que distingue documento fiscal real
-- (série 1, vai à SEFAZ) de registro interno sem validade fiscal (série 99).
-- Execute no Supabase SQL Editor (já aplicado via MCP em 2026-07-27).
--
-- nfe.serie e a numeração independente por série (nfe_numeracao / proxima_nfe)
-- já existiam antes desta migration — só faltava esta coluna pra distinguir
-- o TIPO de documento por trás do número de série.

ALTER TABLE public.nfe
  ADD COLUMN tipo_documento varchar(20) NOT NULL DEFAULT 'nfe_sefaz'
    CHECK (tipo_documento IN ('nfe_sefaz', 'nota_interna'));
