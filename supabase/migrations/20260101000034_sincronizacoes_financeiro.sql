-- Achado (2026-08-14, guard de frescor do sync financeiro): a tabela
-- `sincronizacoes_financeiro` já existe em produção (criada fora do
-- controle de versão, junto com src/jobs/sync-financeiro-legado.js — esse
-- job em si ainda não está commitado neste repo) mas nunca teve uma
-- migration rastreada. CREATE TABLE IF NOT EXISTS é um no-op em produção
-- (a tabela já existe com este schema exato, confirmado por consulta
-- direta) e só passa a criar a tabela em ambientes novos (local/CI), que
-- precisam dela pra rodar os testes do guard de frescor
-- (financialSyncGuard.js).
CREATE TABLE IF NOT EXISTS public.sincronizacoes_financeiro (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'executando', -- executando | concluido | concluido_com_erros | falhou
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz,
  dry_run boolean NOT NULL DEFAULT false,
  total_lido integer,
  total_atualizado integer,
  total_sem_alteracao integer,
  total_sem_match integer,
  total_conflito integer,
  total_cancelado integer,
  total_com_erro integer,
  total_revisao_resolvida integer,
  total_encerrado_com_saldo integer,
  total_criado integer,
  cursor_final timestamptz,
  mapeamento_colunas jsonb,
  mensagem_erro text,
  host_origem text
);
CREATE INDEX IF NOT EXISTS idx_sincronizacoes_financeiro_iniciado_em ON public.sincronizacoes_financeiro (dry_run, iniciado_em DESC);
