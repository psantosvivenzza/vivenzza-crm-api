-- Achado de segurança (mesmo padrão da PR #77 pra fn_sincronizar_baixa_legado,
-- migration 20260101000056 daquela PR): Supabase concede EXECUTE em toda
-- function nova do schema public a PUBLIC por padrão (comportamento padrão do
-- Postgres), e PostgREST expõe qualquer function de public como RPC pros
-- papéis anon/authenticated salvo REVOKE explícito — nunca feito aqui.
--
-- fn_baixar_titulo/fn_estornar_baixa/fn_aprovar_estorno/fn_rejeitar_estorno
-- são SECURITY INVOKER (não declaram SECURITY DEFINER) e não fazem nenhuma
-- checagem de papel no corpo — a única barreira real é o gate
-- adminOuFinanceiro em src/routes/financeiro.js/src/middleware/auth.js, que
-- roda ANTES do backend chamar supabase.rpc(...) com a service_role key. Se
-- EXECUTE também estiver liberado pra anon/authenticated no Postgres, um JWT
-- authenticated qualquer (ou a chave anon exposta no frontend) pode chamar
-- essas RPCs financeiras direto via PostgREST, contornando o gate por
-- completo — mesma classe de achado da PR #77.
--
-- Não mexe no corpo funcional de nenhuma das 4 functions (migrations
-- 000058-000061) — só ajusta GRANT/REVOKE. service_role mantém EXECUTE (é o
-- papel real usado por src/lib/supabase-admin.server.js via
-- SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY). postgres (owner/superuser)
-- não é tocado — revogar dele não teria efeito (superuser ignora ACL).
--
-- Verificação pendente (não executada aqui — sem acesso a produção real): ver
-- query read-only reportada à supervisão em
-- docs/claude-context/verificacao-producao-estornos-baixar-titulo.md pra
-- confirmar o estado real de GRANT dessas 4 functions em produção antes de
-- aplicar esta migration lá.
--
-- anon/authenticated/service_role são papéis do Supabase que não existem num
-- Postgres local/CI vanilla — cria-os aqui (NOLOGIN, mesmo padrão desta PR
-- #77) só pra REVOKE/GRANT terem um papel real pra apontar em ambientes
-- novos. No Supabase real isso é no-op (papéis já existem, IF NOT EXISTS não
-- recria). Idempotente mesmo se esta migration acabar aplicada depois da
-- 20260101000056 da PR #77, que faz a mesma checagem pros mesmos 3 papéis.
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

-- As 4 functions são SECURITY INVOKER — EXECUTE na function sozinho não
-- basta, o papel chamador também precisa de privilégio direto nas tabelas
-- que o corpo toca (ver 000058-000061: SELECT/INSERT/UPDATE em
-- baixas_financeiras e estornos_financeiros, SELECT/UPDATE em
-- contas_financeiras). Em qualquer projeto Supabase real, service_role JÁ
-- TEM esse acesso — bootstrap do próprio Supabase, independente de migration
-- nossa; re-conceder aqui é idempotente e no-op lá. Escopado só às 3 tabelas
-- que estas functions tocam — nunca um GRANT ALL amplo. Papéis são de
-- CLUSTER (sobrevivem a db:local:reset, que só recria o database) — por isso
-- este GRANT roda incondicionalmente, nunca só "se o papel acabou de ser
-- criado agora".
GRANT SELECT, INSERT, UPDATE ON public.contas_financeiras TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.baixas_financeiras TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.estornos_financeiros TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_baixar_titulo(uuid, numeric, date, text, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_estornar_baixa(uuid, uuid, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_aprovar_estorno(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_rejeitar_estorno(uuid, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.fn_baixar_titulo(uuid, numeric, date, text, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_estornar_baixa(uuid, uuid, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_aprovar_estorno(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_rejeitar_estorno(uuid, uuid, text) TO service_role;
