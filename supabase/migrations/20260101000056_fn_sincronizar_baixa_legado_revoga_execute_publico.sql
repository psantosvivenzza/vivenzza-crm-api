-- Achado de segurança (2026-09-11, consulta read-only confirmada via painel
-- do Supabase): fn_sincronizar_baixa_legado tinha EXECUTE concedido a
-- PUBLIC, anon, authenticated, postgres e service_role — ou seja, qualquer
-- cliente com um JWT válido do Supabase (authenticated) ou até sem login
-- (anon, se a chave anon estiver exposta, como normalmente está no
-- frontend) podia chamar esta RPC DIRETO via PostgREST, contornando
-- completamente o gate adminOuFinanceiro de src/routes/financeiro.js e
-- src/middleware/auth.js. Supabase expõe toda function em `public` via
-- PostgREST por padrão, salvo REVOKE explícito — nunca foi revogado aqui.
--
-- Esta migration NÃO toca o corpo funcional da function (ver
-- 20260101000055_fn_sincronizar_baixa_legado.sql, cópia fiel de produção) —
-- só ajusta privilégios. Escopo pedido: revogar de PUBLIC/anon/authenticated,
-- conceder só a service_role (o papel que src/lib/supabase-admin.server.js
-- usa via SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY — é exatamente como
-- sync-financeiro-legado.js já chama esta RPC hoje, então isso não quebra
-- nada em produção). postgres (owner/superuser) não é tocado — revogar dele
-- não teria efeito (superuser ignora ACL) e não fazia parte do pedido.
--
-- anon/authenticated/service_role são papéis do Supabase que não existem
-- num Postgres local/CI vanilla — cria-os aqui (NOLOGIN, mesmo padrão do
-- Supabase: PostgREST autentica via JWT, nunca login direto) só pra
-- REVOKE/GRANT terem um papel real pra apontar em ambientes novos. No
-- Supabase real isso é no-op (papéis já existem, IF NOT EXISTS não recria).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN;
  END IF;
END $$;

-- fn_sincronizar_baixa_legado é SECURITY INVOKER (não DEFINER, confirmado no
-- corpo capturado em 20260101000055) — EXECUTE na function sozinho não
-- basta, o papel chamador também precisa de privilégio direto nas tabelas
-- que o corpo toca (SELECT/INSERT/UPDATE em baixas_financeiras,
-- SELECT/UPDATE em contas_financeiras). Em qualquer projeto Supabase real,
-- service_role JÁ TEM esse acesso de verdade — é bootstrap do próprio
-- Supabase, independente de qualquer migration nossa; re-conceder aqui é
-- idempotente e no-op lá (GRANT de privilégio já concedido não faz nada).
-- Escopado às 2 tabelas que esta function toca — nunca um GRANT ALL amplo.
-- Papéis são de CLUSTER (sobrevivem a db:local:reset, que só recria o
-- database) — por isso este GRANT roda incondicionalmente, nunca só "se o
-- papel acabou de ser criado agora".
GRANT SELECT, INSERT, UPDATE ON public.contas_financeiras TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.baixas_financeiras TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_sincronizar_baixa_legado(uuid, numeric, date, text, boolean, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.fn_sincronizar_baixa_legado(uuid, numeric, date, text, boolean, boolean) FROM anon;
REVOKE EXECUTE ON FUNCTION public.fn_sincronizar_baixa_legado(uuid, numeric, date, text, boolean, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sincronizar_baixa_legado(uuid, numeric, date, text, boolean, boolean) TO service_role;
