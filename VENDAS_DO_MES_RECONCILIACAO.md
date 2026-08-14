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

## ⚠️ NÃO HOMOLOGADO — achado que impede fechar 100% nesta rodada

Testei 3 fontes adicionais tentando explicar o R$6.493,55 restante:

1. **`EN_RepresMensal`** (tabela de agregação diária por representante): bate
   EXATO com Ana (R$5.302,62) e Diego (R$19.285,83) — mas **tem um bug de
   duplicidade comprovado**: pelo menos 3 datas (Ana 06/08 e 13/08, Tais
   11/08) têm valor exatamente 2x a nota real correspondente em `EN_Notas`
   (confirmado nota a nota). Ou seja, essa tabela não é confiável como fonte
   — só "acerta" Ana/Diego possivelmente por coincidência ou por outro
   padrão de erro que não investiguei a fundo.
2. **`ES_Pedidos`** (domínio comercial): bate exato com Ana/Tais, mas
   Diego vem R$4.391,70 ACIMA do valor da tela — e essa diferença é
   explicada EXATAMENTE por bonificação (R$1.845,70) + a remessa CFOP 5910
   indeterminada (R$2.546,00) atribuídas a ele. Ou seja, pedido conta
   mercadoria que saiu como bonificação/remessa, não como venda de verdade —
   consistente com a regra de negócio (pedido ≠ venda).
3. **`ECF_Notas`** (cupom fiscal/PDV): vazia (0 linhas) — descartada.

**Conclusão honesta**: a tela "Consultar Vendas Mensais Repres.(CR)" no
NetVision muito provavelmente usa `EN_RepresMensal` (ou processo parecido) —
que tem um bug de duplicidade comprovado. **Não dá pra afirmar que
R$28.011,05 é, ele mesmo, o número fiscalmente correto.** Pela regra estrita
que o usuário definiu (nota válida + CFOP venda + não cancelada), o número
confiável hoje é **R$21.517,50** pra esses 3 representantes — não R$28.011,05.

## Origem do antigo número de pedidos de Diego (R$23.677,53)

Eram 18 pedidos com `StatusPedido=5` (comercialmente "faturados") somando
R$23.677,53. Comparado com o valor fiscal real (R$14.176,03 + bonificação
R$1.845,70 + remessa indeterminada R$2.546,00 = R$18.567,73), ainda sobra
R$5.109,80 — o mesmo delta da reconstrução estrita, não coincidência: é a
mesma causa (pedidos que viraram bonificação/remessa, mais uma parcela sem
explicação encontrada até agora).

## REGRA VENDAS DO MÊS HOMOLOGADA: **NÃO**

Não declarado homologado por aproximação, conforme instrução explícita.
Falta: entender de onde vem `EN_RepresMensal` (ou o que a tela realmente
consulta) antes de confiar em qualquer número como "o" total de vendas —
isso precisa de alguém que opere o NetVision confirmando o processo real por
trás da tela, não é algo que dá pra descobrir só consultando o banco.

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
