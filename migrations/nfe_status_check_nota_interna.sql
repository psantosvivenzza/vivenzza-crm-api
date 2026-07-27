-- Amplia a CHECK constraint de nfe.status pra aceitar os dois status exclusivos
-- de nota interna (série 99) — descoberta em produção durante o teste local:
-- a constraint nfe_status_check já existia (rascunho/enviada/autorizada/
-- rejeitada/cancelada/denegada) e não estava documentada em migrations/ até aqui.
-- Execute no Supabase SQL Editor (já aplicado via MCP em 2026-07-27).

ALTER TABLE public.nfe DROP CONSTRAINT nfe_status_check;
ALTER TABLE public.nfe ADD CONSTRAINT nfe_status_check
  CHECK (status IN ('rascunho', 'enviada', 'autorizada', 'rejeitada', 'cancelada', 'denegada', 'emitida_interna', 'cancelada_interna'));
