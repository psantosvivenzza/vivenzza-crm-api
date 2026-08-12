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

CREATE TABLE IF NOT EXISTS public.usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  email text NOT NULL UNIQUE,
  role text DEFAULT 'vendedor',
  ativo boolean DEFAULT true,
  criado_em timestamptz DEFAULT now(),
  senha_hash text,
  telefone text,
  legacy_id text
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
