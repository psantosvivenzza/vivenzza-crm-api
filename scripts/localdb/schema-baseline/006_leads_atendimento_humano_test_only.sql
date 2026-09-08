-- 2026-09-08 — o baseline local de `leads` está bem defasado da produção
-- (faltam ~18 colunas: atendimento_humano, whatsapp_opt_out, handoff_alerta_
-- nivel, status_reativacao, etc. — confirmado via introspecção read-only do
-- OpenAPI do PostgREST na investigação original). Corrigir o baseline
-- inteiro está fora do escopo desta correção; adiciona-se aqui SOMENTE a
-- coluna que o código real de src/routes/sdr.js (processarLara, checagem de
-- handoff humano) de fato consulta pra decidir se a Lara deve ficar em
-- silêncio — necessária pra testar esse caminho de verdade contra o schema
-- local, em vez de depender da consulta falhar por coluna ausente. Tipo e
-- default confirmados via introspecção (boolean, default false). Nunca
-- aplicado em produção — só ambiente sintético local exclusivo.
ALTER TABLE IF EXISTS public.leads
  ADD COLUMN IF NOT EXISTS atendimento_humano boolean DEFAULT false;
