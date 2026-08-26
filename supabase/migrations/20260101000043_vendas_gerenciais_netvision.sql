-- Read-model gerencial de vendas — espelha NetVision EN_NotasRepres, a fonte
-- REAL do relatório oficial "Consulta Vendas por Representante" (comprovado
-- por reconciliação exata: bateu Ana/Diego/Nicole/Tais e o total geral até o
-- centavo — ver VENDAS_DO_MES_RECONCILIACAO.md). NÃO é EN_Notas (que
-- notas_fiscais_netvision já espelha) nem ES_Pedidos — são fontes
-- estruturalmente diferentes que não reconciliam entre si.
--
-- Diferença de propósito, deliberada: notas_fiscais_netvision = domínio
-- FISCAL (usado hoje só pra indicador, nunca pra emissão). Esta tabela =
-- domínio GERENCIAL/COMERCIAL (inclui Série 99 sempre, sem exceção — é
-- exatamente o que o NetVision já faz e o card "Vendas do Mês" deve refletir
-- daqui pra frente).
--
-- Chave lógica: (codigo_filial, representante_codigo, numero_documento,
-- serie) — testada empiricamente contra as 8.202 linhas históricas de
-- EN_NotasRepres em produção: ZERO colisões com essa combinação de 4 colunas
-- (a UNIQUE INDEX real do NetVision usa 8 colunas — CodigoFilial+
-- Representante+NumeroDocumento+Serie+Emitente+CodigoPDV+
-- StatusRepresentante+NroRegistro — mas as 12 colisões observadas em
-- filial+numero+serie sozinho eram sempre entre representantes DIFERENTES,
-- nunca o mesmo representante repetido; nenhuma delas sobrevive ao
-- acréscimo de representante_codigo à chave).
CREATE TABLE IF NOT EXISTS public.vendas_gerenciais_netvision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text NOT NULL UNIQUE, -- "{codigo_filial}-{representante_codigo}-{serie}-{numero_documento}"
  codigo_filial text NOT NULL,
  representante_codigo text NOT NULL,
  representante_nome text,
  numero_documento integer NOT NULL,
  serie text NOT NULL,
  data_emissao date NOT NULL,
  valor_documento numeric(14,2) NOT NULL,
  pagamento_a_vista boolean NOT NULL DEFAULT false,
  condicao_pagamento text,
  numero_titulo integer,
  nro_registro integer,
  emitente text,
  codigo_pdv text,
  status_representante smallint,
  importado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  metadata jsonb -- linha bruta do NetVision, auditoria
);
CREATE INDEX IF NOT EXISTS idx_vgnv_data_emissao ON public.vendas_gerenciais_netvision (data_emissao);
CREATE INDEX IF NOT EXISTS idx_vgnv_representante ON public.vendas_gerenciais_netvision (representante_codigo);
CREATE INDEX IF NOT EXISTS idx_vgnv_codigo_filial ON public.vendas_gerenciais_netvision (codigo_filial);
CREATE INDEX IF NOT EXISTS idx_vgnv_serie ON public.vendas_gerenciais_netvision (serie);

-- Log de sincronização — mesmo padrão de sincronizacoes_fiscal/
-- sincronizacoes_financeiro, tabela própria pra não misturar o guard de
-- frescor de um domínio com o de outro.
CREATE TABLE IF NOT EXISTS public.sincronizacoes_vendas_gerenciais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando', 'concluido', 'concluido_com_erros', 'falhou')),
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz,
  dry_run boolean NOT NULL DEFAULT true,
  total_lido integer NOT NULL DEFAULT 0,
  total_criado integer NOT NULL DEFAULT 0,
  total_atualizado integer NOT NULL DEFAULT 0,
  total_com_erro integer NOT NULL DEFAULT 0,
  mensagem_erro text,
  host_origem text
);
CREATE INDEX IF NOT EXISTS idx_svg_iniciado_em ON public.sincronizacoes_vendas_gerenciais (iniciado_em DESC);
