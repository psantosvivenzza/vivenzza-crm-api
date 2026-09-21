-- BASELINE LOCAL — NÃO É MIGRATION DE PRODUÇÃO. Nunca aplicar em produção.
--
-- Escopo mínimo: só o necessário pra `npm run test:collection` rodar num
-- checkout limpo, contra um Postgres local vazio. Definições vindas de
-- introspecção read-only da produção real (2026-08-12) — não uma cópia dos
-- arquivos locais antigos (auditoria completa em FASE INFRA-MIGRATION-AUDIT).
--
-- 001_core: usuarios, clientes_erp, automacoes_config (núcleo pré-000028).
-- As colunas de multi-whatsapp/human_call_threshold NÃO entram aqui — vêm
-- de supabase/migrations/20260101000028 e 000029 (migrations reais,
-- replayadas por localdb-reset.mjs logo depois deste baseline).
--
-- ACHADO REAL (2026-09-21, worktree triagem-regressao-20260921): extensão
-- pgcrypto nunca foi versionada em nenhum baseline nem migration git — só
-- existe habilitada em produção porque todo projeto Supabase novo já vem
-- com ela ativa por padrão, instalada no schema "extensions" (não em
-- "public"). supabase/migrations/20260101000069_fila_ligacao_cobranca.sql
-- usa digest() sem qualificar schema (só funciona com "extensions" no
-- search_path do banco) e 20260101000071_voz_indice_hash_telefone_whatsapp.sql
-- chama explicitamente extensions.digest(...) — os dois presumem essa
-- extensão já instalada nesse schema exato. Um checkout limpo com Postgres
-- local recém-inicializado (npm run db:local:reset) travava na 000069 com
-- "função digest(text, unknown) não existe" e, corrigindo só isso, travava
-- de novo na 000071 com "o esquema extensions não existe" — reproduzido de
-- verdade nesta sessão, bloqueando toda a suíte test:collection num
-- worktree novo. gen_random_uuid() logo abaixo NÃO precisa disso: é nativa
-- do Postgres 13+, só digest()/pgcrypto ficava faltando. ALTER DATABASE (em
-- vez de só SET search_path) porque baseline/migrations rodam um arquivo
-- por conexão psql nova (localdb-reset.mjs) — precisa persistir no banco,
-- não só na sessão atual.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET search_path TO "$user", public, extensions', current_database());
END
$$;

CREATE TABLE IF NOT EXISTS public.usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  email text NOT NULL UNIQUE,
  -- ACHADO REAL (2026-09-09): usuarios_role_check EXISTE em produção mas
  -- nunca esteve versionado em nenhuma migration nem neste baseline — só
  -- foi descoberto quando a criação do primeiro usuário role='financeiro'
  -- falhou de verdade em produção (a aplicação já validava 'financeiro'
  -- desde a PR #75, mas o banco ainda não). Definição confirmada por
  -- leitura direta do catálogo real (pg_constraint, via SQL Editor):
  -- CHECK ((role = ANY (ARRAY['admin'::text, 'vendedor'::text]))).
  -- Reproduzida aqui FIEL ao estado original (só admin/vendedor) de
  -- propósito — supabase/migrations/20260101000047_usuarios_role_check_
  -- financeiro.sql é quem adiciona 'financeiro' por cima, replayada por
  -- localdb-reset.mjs logo depois deste baseline, exatamente como vai
  -- acontecer em produção. Isso é o que faltava pro teste local conseguir
  -- reproduzir a falha real antes da migration — sem isso, o baseline
  -- deixava passar role='financeiro' sem checagem nenhuma, mascarando o
  -- gap que só apareceu em produção.
  role text DEFAULT 'vendedor' CONSTRAINT usuarios_role_check CHECK (role = ANY (ARRAY['admin'::text, 'vendedor'::text])),
  ativo boolean DEFAULT true,
  criado_em timestamptz DEFAULT now(),
  senha_hash text,
  telefone text,
  legacy_id text,
  -- Lidas/gravadas por src/routes/usuarios.js (SELECT_FIELDS, POST, PATCH) —
  -- faltavam neste baseline de dev/teste (achado em 2026-09-07 testando a
  -- rota real de criação/edição de usuário; não é migration de produção).
  meta_mensal numeric,
  comissao_sem_meta numeric,
  comissao_com_meta numeric
);

CREATE TABLE IF NOT EXISTS public.clientes_erp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('PF', 'PJ')),
  razao_social text NOT NULL,
  nome_fantasia text,
  cnpj_cpf text,
  contatos jsonb DEFAULT '[]'::jsonb,
  endereco jsonb DEFAULT '{}'::jsonb,
  data_cadastro date,
  ativo boolean DEFAULT true,
  em_revisao boolean DEFAULT false,
  criado_em timestamptz DEFAULT now(),
  data_ultima_compra date,
  observacoes text,
  representante_nome text,
  vendedor_responsavel text,
  vendedor_responsavel_usuario_id uuid REFERENCES public.usuarios(id),
  CONSTRAINT clientes_erp_legacy_id_unique UNIQUE (legacy_id)
);

-- Núcleo de automacoes_config — singleton (id sempre 1). Colunas
-- multi-whatsapp/human_call_threshold chegam via 000028/000029 (reais).
CREATE TABLE IF NOT EXISTS public.automacoes_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  sdr_ativo boolean NOT NULL DEFAULT true,
  voz_ativa boolean NOT NULL DEFAULT true,
  atualizado_em timestamptz DEFAULT now(),
  reativacao_ativa boolean NOT NULL DEFAULT true,
  cobranca_whatsapp_ativa boolean NOT NULL DEFAULT false,
  handoff_alerta_ativo boolean NOT NULL DEFAULT false,
  nba_shadow_mode boolean NOT NULL DEFAULT false,
  score_shadow_mode boolean NOT NULL DEFAULT false,
  shadow_max_customers integer NOT NULL DEFAULT 50 CHECK (shadow_max_customers > 0)
);
INSERT INTO public.automacoes_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
