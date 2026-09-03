-- Achado (2026-09-02, ao rodar executarSincronizacaoFinanceira contra Postgres
-- local pela primeira vez): contas_financeiras.valor_pago_legado já é lida/
-- comparada por src/lib/financeiroLegado.js (decidirAtualizacao) e pela RPC
-- fn_sincronizar_baixa_legado (não versionada — ver nota em
-- 20260101000034_sincronizacoes_financeiro.sql, mesmo padrão) mas nunca teve
-- migration própria — só existe no schema live de produção. ADD COLUMN IF NOT
-- EXISTS é no-op lá; só passa a existir em ambientes novos (local/CI), que
-- precisam dela pra rodar o job de sync financeiro de ponta a ponta nos testes.
ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS valor_pago_legado numeric;
