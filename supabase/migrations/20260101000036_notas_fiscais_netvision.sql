-- Fiscal read model — espelho, só leitura do ponto de vista de negócio.
-- Nunca escrito por nada além do sync READ-ONLY do NetVision
-- (src/jobs/sync-vendas-fiscais-legado.js). Nunca emite/cancela NF, nunca
-- chama SEFAZ, nunca altera pedidos/contas_financeiras.
--
-- Achados que moldam este schema (ver VENDAS_DO_MES_RECONCILIACAO.md):
--   - CFOP mora em EN_Notas."NaturezaOperacao1" (char4), não numa coluna
--     "CFOP" direta.
--   - NaturezaOperacao.Sequencia não é única — pelo menos um CFOP (5910)
--     tem descrição ambígua na própria base do NetVision. cfop_ambiguo
--     marca isso, nunca decide sozinho.
--   - Vínculo pedido→nota não é confiável por ID (NumeroPedido sempre 0)
--     — pedido_legacy_id fica NULL na esmagadora maioria, nunca inventado.
--   - Só CFOP 5102/6102 confirmados como venda nesta instalação/período.
--     Lista fechada deliberadamente — não amplia sozinha.
CREATE TABLE IF NOT EXISTS public.notas_fiscais_netvision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_nfe_id text NOT NULL UNIQUE, -- "{CodigoFilial}-{NumeroNota}"
  numero integer NOT NULL,
  codigo_filial text NOT NULL,
  tipo_nota text NOT NULL, -- VEN | BON | NS | ... (bruto do NetVision)
  cliente_codigo text,
  representante_codigo text, -- Comissionado, trim
  representante_nome text, -- via EN_Representantes.Nome no momento do sync, snapshot de texto (mesmo padrão de pedidos.vendedor_nome)
  cfop text, -- NaturezaOperacao1, bruto
  cfop_classificacao text NOT NULL DEFAULT 'INDETERMINADO', -- VENDA | BONIFICACAO | INDETERMINADO | OUTROS
  cfop_ambiguo boolean NOT NULL DEFAULT false,
  valor_nota numeric(14,2) NOT NULL,
  valor_total_produtos numeric(14,2),
  data_emissao date NOT NULL,
  cancelada smallint NOT NULL DEFAULT 0, -- valor bruto (0/1/2/3), nunca simplificar sem checar os 4 estados
  pedido_legacy_id text, -- quase sempre NULL — vínculo não confiável, nunca inventado
  importado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  metadata jsonb -- linha bruta do NetVision, auditoria
);
CREATE INDEX IF NOT EXISTS idx_nfnv_data_emissao ON public.notas_fiscais_netvision (data_emissao);
CREATE INDEX IF NOT EXISTS idx_nfnv_representante ON public.notas_fiscais_netvision (representante_codigo);
CREATE INDEX IF NOT EXISTS idx_nfnv_cfop_classificacao ON public.notas_fiscais_netvision (cfop_classificacao);
CREATE INDEX IF NOT EXISTS idx_nfnv_codigo_filial ON public.notas_fiscais_netvision (codigo_filial);
