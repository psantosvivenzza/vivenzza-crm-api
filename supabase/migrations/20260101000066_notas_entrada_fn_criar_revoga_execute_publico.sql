-- Achado de segurança — mesmo padrão já corrigido em 20260101000056 (PR #77,
-- fn_sincronizar_baixa_legado) e 20260101000062 (PR #79, RPCs de
-- estorno/baixa): Supabase concede EXECUTE em toda function nova do schema
-- public a PUBLIC por padrão (comportamento padrão do Postgres), e PostgREST
-- expõe qualquer function de public como RPC pros papéis anon/authenticated
-- salvo REVOKE explícito — nunca feito para fn_criar_nota_entrada.
--
-- fn_criar_nota_entrada é SECURITY INVOKER (não declara SECURITY DEFINER) e
-- não faz nenhuma checagem de papel no corpo — a única barreira real hoje é
-- o gate de PAPEIS_FINANCEIROS em src/routes/notas-entrada.js (e só quando
-- gerar_conta_pagar=true; sem isso a rota nunca teve restrição de papel),
-- que roda ANTES do backend chamar supabase.rpc(...) com a service_role key.
-- Se EXECUTE também estiver liberado pra anon/authenticated no Postgres, um
-- JWT authenticated qualquer (ou a chave anon exposta no frontend) pode
-- chamar esta RPC direto via PostgREST (POST /rpc/fn_criar_nota_entrada),
-- contornando o gate por completo — inclusive o caso gerar_conta_pagar=true,
-- que o gate deveria restringir a admin/financeiro.
--
-- Não mexe no corpo funcional da function (migration 000065) — só ajusta
-- GRANT/REVOKE. service_role mantém EXECUTE (é o papel real usado por
-- src/lib/supabase-admin.server.js via SUPABASE_SECRET_KEY/
-- SUPABASE_SERVICE_ROLE_KEY). postgres (owner/superuser) não é tocado —
-- revogar dele não teria efeito (superuser ignora ACL).
--
-- atualizar_saldo_estoque() (migration 000064) NÃO recebe o mesmo tratamento
-- aqui: é uma função de TRIGGER (RETURNS trigger), e o PostgREST exclui
-- explicitamente do catálogo de RPCs expostas qualquer function cujo tipo de
-- retorno seja `trigger`/`event_trigger` (não tem como chamá-la fora do
-- contexto de um trigger real — NEW/OLD não existem). Não presumir sem essa
-- justificativa; documentado aqui pra não parecer uma omissão.
--
-- Verificação pendente (sem acesso a produção real nesta sessão) — ver
-- consultas read-only prontas em
-- docs/financeiro/verificacao-producao-notas-entrada-dre.md antes de aplicar
-- esta migration em produção.
--
-- anon/authenticated/service_role são papéis do Supabase que não existem num
-- Postgres local/CI vanilla — cria-os aqui (NOLOGIN, mesmo padrão das
-- migrations 000056/000062) só pra REVOKE/GRANT terem um papel real pra
-- apontar em ambientes novos. No Supabase real isso é no-op (papéis já
-- existem, IF NOT EXISTS não recria). Idempotente mesmo se aplicada em
-- qualquer ordem relativa às migrations 000056/000062 dessas outras PRs.
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

-- fn_criar_nota_entrada é SECURITY INVOKER — EXECUTE na function sozinho não
-- basta, o papel chamador também precisa de privilégio direto nas tabelas
-- que o corpo toca (INSERT em notas_entrada/notas_entrada_itens/
-- movimentacoes_estoque/contas_financeiras, UPDATE em produtos/notas_entrada,
-- SELECT via RETURNING não conta como select direto mas o restante sim).
-- INSERT em movimentacoes_estoque dispara trg_atualizar_saldo
-- (atualizar_saldo_estoque(), migration 000064) — também SECURITY INVOKER,
-- roda com o privilégio de quem inseriu a movimentação, então service_role
-- precisa também de INSERT/UPDATE em estoque (o INSERT ... ON CONFLICT DO
-- UPDATE do corpo da função) para o trigger não falhar por 42501. Em
-- qualquer projeto Supabase real, service_role JÁ TEM esse acesso — bootstrap
-- do próprio Supabase, independente de migration nossa; re-conceder aqui é
-- idempotente e no-op lá. Escopado só às tabelas que esta function (e seu
-- trigger) tocam — nunca um GRANT ALL amplo. Papéis são de CLUSTER
-- (sobrevivem a db:local:reset, que só recria o database) — por isso este
-- GRANT roda incondicionalmente, nunca só "se o papel acabou de ser criado
-- agora".
GRANT SELECT, INSERT, UPDATE ON public.notas_entrada TO service_role;
GRANT SELECT, INSERT ON public.notas_entrada_itens TO service_role;
GRANT SELECT, INSERT ON public.movimentacoes_estoque TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.estoque TO service_role;
GRANT SELECT, UPDATE ON public.produtos TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.contas_financeiras TO service_role;

REVOKE EXECUTE ON FUNCTION public.fn_criar_nota_entrada(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_criar_nota_entrada(jsonb) TO service_role;
