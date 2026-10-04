-- 2026-09-28 — GET /api/leads (src/routes/leads.js) sempre selecionou o
-- embed `clientes_erp!leads_cliente_erp_id_fkey(id, legacy_id, razao_social,
-- cnpj_cpf, data_ultima_compra)`, mas o baseline local de `leads` nunca teve
-- a constraint de FK nomeada — `cliente_erp_id` é só `text` solto (ver
-- 004_crm_whatsapp.sql), sem nenhuma referência a clientes_erp. Sem a
-- constraint, o compat client local (src/lib/localdev/pgCompatClient.js)
-- não consegue resolver o embed nomeado e lança "constraint de FK não
-- encontrada no catálogo" — gap real, nunca exercitado antes porque nenhum
-- teste local até agora chamava GET /api/leads contra Postgres (só
-- DELETE /:id, via leads-delete-admin-only-denylist-20260913.test.mjs).
--
-- Referencia clientes_erp.legacy_id (não .id) — confirmado pelo próprio
-- código de produção: src/routes/webhook-handler.js grava
-- `cliente_erp_id: clienteErp.legacy_id` (nunca .id), e ambas as colunas são
-- `text`, batendo com a UNIQUE constraint em clientes_erp.legacy_id
-- (clientes_erp_legacy_id_unique, já existente em 001_core.sql).
--
-- Nunca aplicado em produção — só ambiente sintético local exclusivo (mesmo
-- espírito de 006_leads_atendimento_humano_test_only.sql).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'leads_cliente_erp_id_fkey' AND table_name = 'leads'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_cliente_erp_id_fkey
      FOREIGN KEY (cliente_erp_id) REFERENCES public.clientes_erp(legacy_id);
  END IF;
END $$;
