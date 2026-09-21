-- TESTE/LOCAL APENAS — nunca refletir em supabase/migrations nem produção.
--
-- Estas 4 tabelas existem em produção (Supabase) mas nunca tiveram uma
-- migration git-versionada em supabase/migrations/ que as CRIASSE (mesmo
-- padrão de outras tabelas já cobertas por este baseline — ver
-- docs/cobranca-ai/LOCAL_DEVELOPMENT.md e docs/MIGRATIONS_DRIFT_AUDIT_2026-09-03.md).
-- Sem elas, `npm run db:local:reset` falha:
--   - migration 20260101000072 (voz_retorno_humano_fecha_o_ciclo.sql): coluna
--     `voice_calls.tarefa_id uuid references public.tarefas(id)`.
--   - migration 20260101000073 (rls_tabelas_expostas_ao_anon.sql): faz
--     `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` em
--     public.conferencias_financeiro e public.meta_budget_guard_log — falha
--     se as tabelas não existirem. Ao investigar esse blocker, o mesmo
--     arquivo revelou uma 4ª tabela ausente pelo mesmo motivo, não citada
--     originalmente: public.sincronizacao_financeiro_erros (gravada por
--     src/jobs/sync-financeiro-legado.js, mas nunca versionada).
--
-- Origem dos dados: introspecção SOMENTE DE METADADOS em produção, via
-- OpenAPI/Swagger do PostgREST (GET {SUPABASE_URL}/rest/v1/, com a
-- service_role key já configurada no .env local deste projeto). Nenhuma linha
-- de tabela foi consultada, nenhuma credencial foi impressa, nenhum DDL/DML
-- rodou contra produção. Esse é o único caminho de metadados disponível
-- neste ambiente: PostgREST não expõe information_schema/pg_catalog (só o
-- schema `public`), e não há DATABASE_URL / Management API / Supabase CLI
-- autenticado configurados aqui — ver memória de sessão
-- "supabase-producao-acesso-somente-rest" e
-- docs/MIGRATIONS_DRIFT_AUDIT_2026-09-03.md, seção "Metodologia e
-- limitações de acesso". Colunas, tipos, defaults, nullability (NOT NULL ==
-- campo listado em `required` no schema OpenAPI, que reflete
-- pg_attribute.attnotnull — confirmado cruzando com meta_budget_guard_log
-- abaixo) e alvos de FK vêm dessa introspecção (2026-09-21).
--
-- Exceção: meta_budget_guard_log tem definição SQL completa e literal em
-- `migrations/meta_budget_guard.sql` (árvore legada antiga — não é aplicada
-- por `db:local:reset`, que só usa supabase/migrations/, ver
-- scripts/localdb-config.mjs). Suas colunas batem 1:1 com o OpenAPI de
-- produção (mesmos nomes/tipos/nullability); usada aqui verbatim por ser a
-- fonte mais fiel disponível — inclui CHECK/índices/comentário que o OpenAPI
-- não expõe.
--
-- BLOQUEIOS DOCUMENTADOS (indeterminado com o acesso disponível nesta sessão
-- — nada abaixo foi inventado/chutado):
--   - Índices, CHECK constraints (além dos já confirmados em
--     meta_budget_guard_log), triggers e GRANT/REVOKE exatos de
--     public.tarefas, public.conferencias_financeiro e
--     public.sincronizacao_financeiro_erros em produção: PostgREST não expõe
--     pg_indexes/pg_constraint/pg_trigger/information_schema.role_table_grants,
--     e não há acesso a pg_catalog direto nesta sessão.
--   - RLS de conferencias_financeiro e meta_budget_guard_log: já é coberto
--     pela própria migration 20260101000073 (`ENABLE ROW LEVEL SECURITY`,
--     sem policy) quando ela roda na 2ª fase do reset — não duplicado aqui.
--   - RLS de tarefas e sincronizacao_financeiro_erros: nenhuma migration
--     versionada habilita RLS nelas; status real em produção indeterminado
--     com o acesso disponível — não presumido aqui.
--   - sincronizacao_financeiro_erros.sincronizacao_id referencia
--     sincronizacoes_financeiro(id) em produção, mas essa tabela só é criada
--     pela migration 20260101000034 — que roda na 2ª fase do reset (depois
--     de TODO o baseline, ver localdb-reset.mjs). Não é possível declarar
--     essa FK aqui sem quebrar a ordem baseline-antes-de-migrations já
--     existente neste repositório (restrição estrutural pré-existente, não
--     introduzida por este arquivo). Coluna mantida como uuid simples, sem
--     REFERENCES.

CREATE TABLE IF NOT EXISTS public.tarefas (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid REFERENCES public.leads(id),
  titulo            text NOT NULL,
  descricao         text,
  prazo             timestamptz,
  status            text DEFAULT 'pendente',
  responsavel_id    uuid REFERENCES public.usuarios(id),
  criado_em         timestamptz DEFAULT now(),
  tipo              text DEFAULT 'outro',
  origem            text NOT NULL DEFAULT 'manual',
  resumo_ia         text,
  intencao_ia       text,
  proxima_acao_ia   text,
  prioridade_ia     text
);

CREATE TABLE IF NOT EXISTS public.conferencias_financeiro (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  executada_em            timestamptz NOT NULL DEFAULT now(),
  bateu                   boolean NOT NULL,
  total_criticas          integer NOT NULL DEFAULT 0,
  erp_abertos             integer,
  erp_saldo               numeric,
  crm_abertos             integer,
  crm_saldo               numeric,
  crm_aberto_erp_fechado  integer NOT NULL DEFAULT 0,
  crm_fechado_erp_aberto  integer NOT NULL DEFAULT 0,
  valor_pago_diferente    integer NOT NULL DEFAULT 0,
  so_no_crm               integer NOT NULL DEFAULT 0,
  so_no_erp               integer NOT NULL DEFAULT 0,
  amostras                jsonb,
  alertado_em             timestamptz
);

-- meta_budget_guard_log — copiado verbatim de migrations/meta_budget_guard.sql
-- (ver nota de origem no topo do arquivo).
CREATE TABLE IF NOT EXISTS public.meta_budget_guard_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('account', 'campaign', 'adset')),
  action text NOT NULL CHECK (action IN ('alerted', 'paused', 'resumed', 'write_failed', 'manual_override')),
  status_before_guard text,
  spend_at_action numeric,
  reason text NOT NULL,
  dia_conta date NOT NULL,
  pause_action_id uuid REFERENCES public.meta_budget_guard_log(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS meta_budget_guard_log_daily_idem
  ON public.meta_budget_guard_log (entity_id, entity_type, action, dia_conta)
  WHERE action IN ('alerted', 'paused');

CREATE UNIQUE INDEX IF NOT EXISTS meta_budget_guard_log_resume_idem
  ON public.meta_budget_guard_log (pause_action_id)
  WHERE action IN ('resumed', 'manual_override');

CREATE INDEX IF NOT EXISTS meta_budget_guard_log_dia_conta_idx
  ON public.meta_budget_guard_log (dia_conta);

COMMENT ON TABLE public.meta_budget_guard_log IS
  'Log de ações do hard-cap de spend do Meta Ads (alerta/pausa/reativação/falha de escrita). pause_action_id liga uma reativação à pausa que ela desfaz — resume só acontece para entidades que o próprio guard pausou (nunca reativa algo pausado manualmente, porque nunca teria uma linha "paused" correspondente).';

-- sincronizacao_financeiro_erros — sincronizacao_id sem REFERENCES por
-- restrição estrutural de ordem (ver bloco de comentário no topo do arquivo).
CREATE TABLE IF NOT EXISTS public.sincronizacao_financeiro_erros (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sincronizacao_id  uuid,
  legacy_id         text,
  mensagem          text NOT NULL,
  criado_em         timestamptz NOT NULL DEFAULT now()
);
