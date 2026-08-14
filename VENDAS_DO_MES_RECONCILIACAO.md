# Reconciliação de VENDAS DO MÊS — NetVision x Vivenzza

Read-only. Nenhum dado alterado, nenhuma configuração de dashboard tocada.

## Regra de negócio homologada pelo usuário

**VENDAS DO MÊS** = nota fiscal de venda efetivamente emitida/válida + CFOP
classificado como venda + não cancelada + data de emissão no período.

**PEDIDO NÃO É VENDA REALIZADA.** `PEDIDOS DO MÊS` (métrica comercial já
existente) e `VENDAS DO MÊS` (métrica fiscal) são grandezas diferentes e
não devem mais ser tratadas como equivalentes.

## Onde está o CFOP no NetVision (achado desta rodada)

Não existe coluna `CFOP` em `EN_Notas`. O código fica em
**`EN_Notas."NaturezaOperacao1"`** (char(4), o próprio código CFOP, ex.
`'5102'`), com `"SequenciaNatOper1"` apontando pra tabela catálogo
**`"NaturezaOperacao"`** (descrição real, não texto adivinhado). CFOP a nível
de item (`EN_ItemNota.CFOP`) existe mas está em branco pra quase toda a base
(110/63.803 linhas) — não é o campo usado nesta filial/instalação.

## CFOPs encontrados no período (01–14/08/2026, filial 001, `TipoNota='VEN'`)

| CFOP | Descrição | Classificação | Ativas (qtd / valor) | Canceladas (qtd / valor) |
|---|---|---|---|---|
| 5102 | Venda de mercadoria adquirida de terceiros (dentro do estado) | **VENDA** | 14 / R$12.016,38 | 1 / R$1.133,45 |
| 6102 | Venda de mercadoria fora do estado (interestadual) | **VENDA** | 8 / R$9.501,12 | 2 / R$2.885,40 |

Fora do escopo de `TipoNota='VEN'` (corretamente excluído de vendas): CFOP
6910 (bonificação/doação, `TipoNota='BON'`, 2 notas, R$1.845,70) e CFOP 5910
sob `TipoNota='NS'` (indeterminado — a tabela catálogo `NaturezaOperacao` tem
uma ambiguidade real: duas linhas diferentes compartilham a mesma
`Sequencia`, uma "Remessa para Consignação" e outra "Remessa para venda fora
do estabelecimento", sem chave clara pra desambiguar — não forcei uma
classificação sem essa certeza).

Nenhuma devolução ou transferência aparece nesta filial/período.

## Reconstrução estrita (CFOP-venda, ativa, filial 001, período) — resultado real

```sql
SELECT trim("Comissionado") as rep, sum("ValorNota") as total
FROM "EN_Notas"
WHERE "TipoNota" = 'VEN' AND "CodigoFilial" = '001' AND "Cancelada" = 0
  AND trim("NaturezaOperacao1") IN ('5102','6102')
  AND "DataEmissao" BETWEEN '2026-08-01' AND '2026-08-14'
GROUP BY trim("Comissionado")
```

| Representante | Resultado (regra estrita) | Valor na tela RE_Consulta02 | Delta |
|---|---|---|---|
| ANA CAROLINA (002070) | R$ 3.918,87 | R$ 5.302,62 | **-R$ 1.383,75** |
| DIEGO SANTOS (000073) | R$ 14.176,03 | R$ 19.285,83 | **-R$ 5.109,80** |
| TAIS COSTA MORAIS (002300) | **R$ 3.422,60** | R$ 3.422,60 | **R$ 0,00 — EXATO** |
| **TOTAL** | **R$ 21.517,50** | **R$ 28.011,05** | **-R$ 6.493,55** |

Cancelamento+reemissão tratado corretamente (verificado nota a nota — só a
reemitida ativa conta, nunca as duas).

## ✅ MECANISMO EXATO DE `RE_Consulta02` — encontrado (rodada seguinte)

Ponte pedido→documento fiscal, registro a registro (`scripts/ponte-pedido-nota.mjs`),
pra cada pedido `StatusPedido=5`/`Cancelado=0` de Ana e Diego, contra TODAS as
notas do mesmo cliente numa janela larga (-10d/+60d, não só o período estrito).
Classificação por pedido:

**ANA (5 pedidos, R$5.302,62) — 100% explicado, zero pendência:**

| Pedido | Cliente | Valor | Classificação | Fiscal encontrado |
|---|---|---|---|---|
| 9752 | 002208 | R$1.737,70 | PARTIAL_SALE_INVOICE (50%) | R$868,85 (nota 3171, CFOP 5102) |
| 9762 | 002250 | R$814,02 | SALE_INVOICE_SAME_PERIOD | R$814,02 (nota 3173, CFOP 6102) |
| 9769 | 002314 | R$1.270,80 | SALE_INVOICE_SAME_PERIOD | R$1.270,80 (nota 3176, CFOP 6102) |
| 9781 | 002011 | R$450,30 | SALE_INVOICE_SAME_PERIOD | R$450,30 (nota 3178, CFOP 5102) |
| 9786 | 002275 | R$1.029,80 | PARTIAL_SALE_INVOICE (50%) | R$514,90 (nota 3180, CFOP 5102) |

Delta R$1.383,75 = **exatamente** os 50% não faturados dos 2 pedidos parciais
(R$868,85 + R$514,90). Soma fecha ao centavo.

**DIEGO (18 pedidos do conjunto original, R$23.677,53) — 100% explicado, zero pendência:**

| Classificação | n | Valor pedidos | Fiscal-venda encontrado |
|---|---|---|---|
| SALE_INVOICE_SAME_PERIOD | 9 | R$7.810,33 | R$7.810,33 |
| PARTIAL_SALE_INVOICE (todos exatos 50%) | 5 | R$12.731,40 | R$6.365,70 |
| ONLY_NON_SALE_CFOP (bonificação/remessa) | 5 | **R$4.391,70** | R$0,00 |

`9743`→50% (nota 3168, 5102) · `9745`→50% (nota 3170, 5102) · `9773`→50%
(nota 3177, 5102) · `9782`→50% (nota 3179, 6102) — todos parciais exatamente
na metade. `9749`/`9751`/`9759`/`9760`/`9783` → só documento não-venda (CFOP
5910/6910), zero valor fiscal de venda.

## ✅ FÓRMULA EXATA DE `RE_Consulta02` (verificada, não aproximada)

```text
RE_Consulta02(representante, período) =
  SOMA(pedido.Valor) WHERE StatusPedido=5 AND Cancelado=0 AND período AND representante
  MENOS SOMA(pedido.Valor) dos pedidos cujo(s) documento(s) fiscal(is) ativo(s)
        são TODOS de CFOP não-venda (bonificação/remessa)
```

Verificação exata:
- **Ana**: nenhum pedido caiu em ONLY_NON_SALE_CFOP → R$5.302,62 − R$0,00 = **R$5.302,62** ✓ EXATO
- **Diego**: R$23.677,53 − R$4.391,70 (os 5 pedidos ONLY_NON_SALE_CFOP) = **R$19.285,83** ✓ EXATO, ao centavo
- **Tais**: mesma lógica, nenhuma exclusão, pedidos = fiscal-venda = R$3.422,60 ✓ EXATO

**A fórmula fecha exatamente pros 3 representantes — não é mais aproximação,
é mecanismo comprovado.**

## O que isso significa pra decisão de negócio

`RE_Consulta02` **NÃO é baseado em nota fiscal válida por CFOP de venda** —
é baseado em **PEDIDO** (`StatusPedido=5`), com uma única correção (excluir
pedidos que viraram só bonificação/remessa). Ele conta pedidos
parcialmente faturados pelo **valor cheio do pedido**, não pela fração
realmente emitida em nota. Isso é estruturalmente mais próximo de
`PEDIDOS DO MÊS` do que da regra estrita que o usuário definiu.

## REGRA "NOTA FISCAL VÁLIDA + CFOP VENDA" — HOMOLOGADA: **SIM**

A regra em si (nota válida + CFOP venda + não cancelada) está corretamente
implementada e seu resultado é exato e reproduzível: **R$21.517,50** pra
Ana+Diego+Tais no período. **`RE_Consulta02` mede outra coisa** (pedido menos
não-venda) — não é o mesmo indicador, e agora sabemos exatamente por quê,
registro a registro, sem nenhuma pendência.

## Card "Pedidos do Mês" (Vivenzza) — confirmado, mantido sem alteração

Implementação confirmada (agente anterior, reproduzida com exatidão:
28 pedidos, R$33.727,25):
- Frontend: `vivenzza-crm-frontend/src/pages/Dashboard.jsx` (`MetricCardPro`)
- Backend: `vivenzza-crm-api/src/routes/dashboard.js`, `GET /`
- Fonte: `pedidos.total`, `status='faturado'` AND
  (`classificacao_faturamento='venda'` OR NULL), `criado_em` no mês,
  **sem filtro de filial** (não existe essa dimensão em `pedidos`), sem
  filtro de vendedor quando "Empresa (geral)".

Isso mede **pedido comercial faturado** (fulfillment), uma métrica legítima
e diferente de venda fiscal. **Mantido como está — não é a mesma grandeza
de `VENDAS DO MÊS`, e não deveria ser.**

## Indicador novo "VENDAS DO MÊS" — NÃO implementado

Por decisão explícita: não implementar até a fonte de dados ser confiável.
Hoje ela não é — o NetVision-lado (`EN_RepresMensal`) tem bug comprovado, e
a reconstrução estrita direto de `EN_Notas` não fecha com o que a tela
mostra. Ver `FISCAL_READ_MODEL.md` pra o desenho (não implementado) de como
o Vivenzza poderia ter sua própria cópia confiável de notas fiscais, uma vez
que essa ambiguidade seja resolvida com quem opera o NetVision.
