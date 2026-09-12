-- BASELINE LOCAL — NÃO É MIGRATION DE PRODUÇÃO. Nunca aplicar em produção.
--
-- 007_notas_entrada_dre: tabelas que existem em produção mas nunca tiveram
-- migration git-versionada nem neste repositório nem na pasta solta
-- migrations/ (mesma situação de usuarios/contas_financeiras/leads nos
-- outros arquivos deste diretório — bootstradas fora de controle de versão,
-- antes deste pipeline existir). Cobrem o fluxo `fn_criar_nota_entrada`
-- (POST/GET /api/notas-entrada) e `GET /api/relatorios/dre`.
--
-- Definições CONFIRMADAS via SQL Editor de produção real ao longo de 3
-- rodadas de auditoria/reprodução (worktree
-- vivenzza-financeiro-dre-notas-repro) — consolidadas em
-- docs/financeiro/schema-real-producao-dre-notas-entrada.md. Nenhuma coluna/
-- constraint/índice foi inventado; toda uma tem proveniência real.
--
-- notas_entrada/notas_entrada_itens/estoque/movimentacoes_estoque NÃO entram
-- aqui — essas já têm migration real própria (supabase/migrations/
-- 20260101000064 e 000065), aplicada logo depois deste baseline pelo mesmo
-- db:local:reset.

-- STUBS mínimos — tabelas reais que existem em produção mas cujo subsistema
-- completo está FORA do escopo do fluxo de Notas de Entrada simples + DRE.
-- Cada uma aqui é reduzida a "id uuid PK", só o suficiente pra permitir criar
-- as FKs reais que apontam pra elas (produtos.linha_id,
-- movimentacoes_estoque.lote_id, nfe.pedido_id). NENHUM dos 2 fluxos
-- versionados nas migrations 000064/000065/000066 toca essas tabelas de
-- verdade — ficam vazias/nunca exercitadas. `leads` já existe em
-- 004_crm_whatsapp.sql (não redefinida aqui).
CREATE TABLE IF NOT EXISTS public.linhas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE TABLE IF NOT EXISTS public.lotes_estoque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);
CREATE TABLE IF NOT EXISTS public.pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid()
);

-- produtos — CONFIRMADO por completo via metadado real de produção.
--
-- ACHADO — duas fontes de "quantidade em estoque" no mesmo schema:
-- `produtos.estoque` (integer, coluna desta própria tabela, default 0) e a
-- tabela separada `estoque` (numeric(14,4), mantida pelo trigger
-- trg_atualizar_saldo via movimentacoes_estoque, migration 000064) coexistem
-- em produção. fn_criar_nota_entrada e atualizar_saldo_estoque() NUNCA tocam
-- `produtos.estoque` — ver docs/financeiro/decisoes-e-riscos-notas-entrada-dre.md.
CREATE TABLE IF NOT EXISTS public.produtos (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  linha_id            uuid REFERENCES public.linhas(id),
  nome                text NOT NULL,
  sku                 text,
  descricao           text,
  preco_b2c           numeric(10,2) DEFAULT 0,
  preco_b2b           numeric(10,2) DEFAULT 0,
  preco_distribuidor  numeric(10,2) DEFAULT 0,
  estoque             integer DEFAULT 0,
  ativo               boolean DEFAULT true,
  criado_em           timestamptz DEFAULT now(),
  ncm                 text,
  cst                 text,
  origem              smallint DEFAULT 0,
  cfop_padrao         text,
  unidade             text DEFAULT 'UN',
  preco_custo         numeric(10,2),
  ean                 text,
  legacy_id           text,
  extra_precos        jsonb DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS produtos_sku_key ON public.produtos (sku);
CREATE UNIQUE INDEX IF NOT EXISTS produtos_legacy_id_uk ON public.produtos (legacy_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_produtos_legacy_id ON public.produtos (legacy_id) WHERE legacy_id IS NOT NULL;

-- nfe / nfe_itens — CONFIRMADAS via metadado real de produção (colunas,
-- precisão/escala, constraints, índices inclusive parciais). pedido_id
-- aponta pro stub acima; lead_id aponta pro `leads` real de 004_crm_whatsapp.sql.
CREATE TABLE IF NOT EXISTS public.nfe (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                varchar(5) NOT NULL DEFAULT 'nfe' CHECK (tipo IN ('nfe','nfce')),
  numero              integer,
  serie               integer NOT NULL DEFAULT 1,
  chave               varchar(44),
  status              varchar(20) NOT NULL DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho','enviada','autorizada','rejeitada','cancelada','denegada','emitida_interna','cancelada_interna')),
  protocolo           varchar(20),
  data_emissao        timestamptz NOT NULL DEFAULT now(),
  natureza_operacao   varchar(60) NOT NULL DEFAULT 'VENDA DE MERCADORIA',
  finalidade          integer NOT NULL DEFAULT 1,
  dest_nome           varchar(60),
  dest_cnpj_cpf       varchar(14),
  dest_ie             varchar(14),
  dest_logradouro     varchar(60),
  dest_numero         varchar(10),
  dest_complemento    varchar(60),
  dest_bairro         varchar(60),
  dest_municipio      varchar(60),
  dest_uf             varchar(2),
  dest_cep            varchar(8),
  dest_fone           varchar(14),
  dest_email          varchar(60),
  transp_modalidade   integer NOT NULL DEFAULT 9,
  transp_frete        numeric(14,2) DEFAULT 0,
  valor_produtos      numeric(14,2),
  valor_frete         numeric(14,2) DEFAULT 0,
  valor_desconto      numeric(14,2) DEFAULT 0,
  valor_icms          numeric(14,2) DEFAULT 0,
  valor_pis           numeric(14,2) DEFAULT 0,
  valor_cofins        numeric(14,2) DEFAULT 0,
  valor_total         numeric(14,2),
  forma_pagamento     varchar(2) NOT NULL DEFAULT '01',
  pedido_id           uuid REFERENCES public.pedidos(id) ON DELETE SET NULL,
  lead_id             uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  usuario_id          uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  xml_enviado         text,
  xml_autorizado      text,
  xml_cancelamento    text,
  motivo_rejeicao     text,
  observacoes         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  dest_cmun           text,
  legacy_id           text,
  tipo_documento      varchar(20) NOT NULL DEFAULT 'nfe_sefaz' CHECK (tipo_documento IN ('nfe_sefaz','nota_interna')),
  ambiente            text CHECK (ambiente IN ('homologacao','producao')),
  hash_xml_enviado    text,
  hash_xml_autorizado text,
  versao_schema       text NOT NULL DEFAULT '4.00',
  correlation_id      uuid,
  enviada_em          timestamptz,
  reconciliada        boolean NOT NULL DEFAULT false,
  CONSTRAINT nfe_chave_key UNIQUE (chave)
);
CREATE UNIQUE INDEX IF NOT EXISTS nfe_legacy_id_uk ON public.nfe (legacy_id);
CREATE INDEX IF NOT EXISTS idx_nfe_chave ON public.nfe (chave);
CREATE INDEX IF NOT EXISTS idx_nfe_emissao ON public.nfe (data_emissao DESC);
CREATE INDEX IF NOT EXISTS idx_nfe_status ON public.nfe (status);
CREATE INDEX IF NOT EXISTS idx_nfe_enviada_pendente ON public.nfe (enviada_em) WHERE status = 'enviada' AND reconciliada = false;
CREATE UNIQUE INDEX IF NOT EXISTS ux_nfe_pedido_autorizada ON public.nfe (pedido_id) WHERE status = 'autorizada' AND pedido_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.nfe_itens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nfe_id          uuid NOT NULL REFERENCES public.nfe(id) ON DELETE CASCADE,
  produto_id      uuid REFERENCES public.produtos(id) ON DELETE SET NULL,
  numero_item     integer NOT NULL,
  codigo          varchar(60),
  descricao       varchar(120) NOT NULL,
  ncm             varchar(8),
  cfop            varchar(4) NOT NULL DEFAULT '5102',
  unidade         varchar(6) NOT NULL DEFAULT 'UN',
  quantidade      numeric(11,4) NOT NULL,
  valor_unitario  numeric(11,4) NOT NULL,
  valor_total     numeric(14,2) NOT NULL,
  cst_icms        varchar(3) NOT NULL DEFAULT '00',
  aliq_icms       numeric(5,2) DEFAULT 0,
  valor_icms      numeric(14,2) DEFAULT 0,
  cst_pis         varchar(2) NOT NULL DEFAULT '07',
  valor_pis       numeric(14,2) DEFAULT 0,
  cst_cofins      varchar(2) NOT NULL DEFAULT '07',
  valor_cofins    numeric(14,2) DEFAULT 0,
  valor_desconto  numeric(14,2) DEFAULT 0,
  legacy_id       text
);
CREATE UNIQUE INDEX IF NOT EXISTS nfe_itens_legacy_id_uk ON public.nfe_itens (legacy_id);
CREATE INDEX IF NOT EXISTS idx_nfe_itens_nfe ON public.nfe_itens (nfe_id);
