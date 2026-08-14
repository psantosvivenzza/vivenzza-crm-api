# Fiscal Read Model — desenho (não implementado)

Só desenho. **Nenhuma tabela criada, nenhum sync escrito além deste
documento.** Pré-requisito antes de implementar: resolver a ambiguidade
registrada em `VENDAS_DO_MES_RECONCILIACAO.md` (de onde `EN_RepresMensal`
tira os números, por que duplica) — não faz sentido espelhar uma fonte que
já sabemos ter bug comprovado.

## Por que precisa

`public.nfe` (Vivenzza) já existe e tem schema adequado, mas é **carga
histórica única, parada em 2026-08-03** — confirmado nesta rodada: só 2
linhas com `data_emissao` em agosto (01–14), a mais recente é 03/08 21:11.
Não serve pra alimentar nenhum indicador do mês corrente. Não usar como
fallback silencioso.

## Fonte confirmada nesta rodada

- `EN_Notas` — cabeçalho da nota. Campos relevantes confirmados:
  `CodigoFilial`, `NumeroNota`, `Cliente`, `TipoNota`, `DataEmissao`,
  `ValorNota`, `ValorTotalProdutos`, `Cancelada`, `Comissionado` (+
  `Comissionado2`..`6`), `NaturezaOperacao1` (CFOP, char4),
  `SequenciaNatOper1` (join pra descrição).
- `NaturezaOperacao` — catálogo de CFOP/natureza de operação (`Sequencia`,
  `NaturezaOperacao`=código, `Descricao`, `GerarTipoNota`, `Comissao`).
  **Achado**: `Sequencia` não é única por filial+`GerarTipoNota` — pelo
  menos um caso reproduzido (CFOP 5910) onde duas descrições diferentes
  compartilham a mesma sequência, sem chave clara pra desambiguar. Qualquer
  sync precisa lidar com isso (guardar o código bruto E a ambiguidade, não
  forçar uma descrição única quando não dá pra saber).
- Vínculo pedido→nota: **não existe de forma confiável** (achado de rodada
  anterior, reconfirmado: `EN_ItemNota.RepresentanteItem` em branco pra toda
  a base do período, sem chave adicional encontrada). Qualquer read model
  fiscal tem que aceitar isso — não pode prometer join exato com `pedidos`.

## Desenho de tabela (proposta, NÃO criada)

```sql
-- PROPOSTA — não executar sem revisão e sem resolver a ambiguidade do
-- EN_RepresMensal primeiro.
CREATE TABLE public.notas_fiscais_netvision (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_nfe_id text NOT NULL UNIQUE, -- "{CodigoFilial}-{NumeroNota}"
  numero integer NOT NULL,
  serie text,
  codigo_filial text NOT NULL,
  tipo_nota text NOT NULL, -- VEN | BON | NS | ... (bruto do NetVision)
  cliente_codigo text,
  representante_codigo text, -- Comissionado, trim
  representantes_secundarios jsonb, -- Comissionado2..6, quando houver
  cfop text, -- NaturezaOperacao1, bruto
  cfop_descricao text, -- via NaturezaOperacao, NULL se ambíguo
  cfop_classificacao text, -- VENDA | BONIFICACAO | DEVOLUCAO | TRANSFERENCIA | REMESSA | OUTROS | INDETERMINADO
  cfop_ambiguo boolean NOT NULL DEFAULT false, -- true = achado tipo "5910/Sequencia duplicada", não confiar cegamente
  valor_nota numeric(14,2) NOT NULL,
  valor_total_produtos numeric(14,2),
  data_emissao date NOT NULL,
  cancelada smallint NOT NULL DEFAULT 0, -- valor bruto do NetVision (0/1/2/3), nunca simplificar pra boolean sem checar os 4 estados
  pedido_legacy_id text, -- NULL na esmagadora maioria — vínculo não confiável, nunca inventar um
  importado_em timestamptz NOT NULL DEFAULT now(),
  metadata jsonb -- linha bruta, auditoria
);
CREATE INDEX idx_nfnv_data_emissao ON public.notas_fiscais_netvision (data_emissao);
CREATE INDEX idx_nfnv_representante ON public.notas_fiscais_netvision (representante_codigo);
CREATE INDEX idx_nfnv_cfop_classificacao ON public.notas_fiscais_netvision (cfop_classificacao);
```

## Regras do sync (quando/se for construído)

- **READ MODEL — nunca escreve em `pedidos`, `contas_financeiras` ou
  qualquer tabela de negócio.** Só popula esta tabela nova.
- Idempotente por `legacy_nfe_id`, upsert (nota pode ser cancelada depois de
  importada — precisa refletir isso numa próxima execução, não só inserir
  uma vez e esquecer).
- **NUNCA** chama SEFAZ, nunca emite, nunca cancela, nunca altera
  certificado/série — é só leitura do NetVision.
- `TipoNota` fica bruto (não filtrar `='VEN'` no sync — deixa o consumidor
  decidir; filtrar cedo demais esconde bonificação/remessa que pode
  interessar outros indicadores no futuro).
- `cfop_ambiguo=true` sempre que a `NaturezaOperacao.Sequencia` não for
  única pra aquele filial+tipo — não decidir por adivinhação.

## O que falta antes de implementar

1. Entender `EN_RepresMensal`: o que gera essa tabela, por que duplica
   valores em pelo menos 3 datas confirmadas. Sem isso, não dá pra saber se
   o read model proposto (baseado direto em `EN_Notas`) vai bater com o que
   o negócio já usa na tela, ou vai criar um TERCEIRO número divergente.
2. Confirmação de negócio sobre a ambiguidade do CFOP 5910 (Remessa pra
   Consignação x Remessa pra venda fora do estabelecimento) — afeta se
   essas notas contam como venda ou não.
3. Autorização explícita separada pra implementar (é infraestrutura nova,
   mesmo sendo só leitura).

Nada disso foi resolvido nesta rodada — fica registrado como desenho.
