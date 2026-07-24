-- Comissões — campos de meta e percentual por vendedor em usuarios
-- Execute este script no Supabase SQL Editor (já aplicado via MCP em 2026-07-23)

ALTER TABLE public.usuarios
  ADD COLUMN meta_mensal numeric(15,2) DEFAULT 0,
  ADD COLUMN comissao_sem_meta numeric(7,4) DEFAULT 1.5,
  ADD COLUMN comissao_com_meta numeric(7,4) DEFAULT 3.0;
