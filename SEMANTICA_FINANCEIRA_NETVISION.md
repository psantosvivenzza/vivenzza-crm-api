# Semântica financeira do NetVision — `ValorPago` x `ValorParcialmentePago`

Read-only. Nenhum dado alterado. Nenhuma tabela criada/modificada.

## O que É confirmado, com alta confiança

Investigação direta no `e01` (sem triggers/procedures no Postgres — a lógica de
negócio original mora no cliente Delphi/Firebird, fora deste banco; a conclusão
abaixo é empírica, não por leitura de código):

- **`ValorParcialmentePago`** = soma cumulativa de pagamentos parciais, batendo
  EXATAMENTE com `CR_PagtoParcial` (ledger de eventos) em 100% dos 2.523 títulos
  populados — confirmado antes e reconfirmado aqui.
- **`ValorPago`** = pagamento final que encerrou o saldo — pra títulos SEM
  histórico de parcial, é o valor inteiro recebido; pra títulos COM histórico de
  parcial, é só o ÚLTIMO pagamento que fechou a conta.
- **`ValorPago + ValorParcialmentePago ≈ ValorDuplicata`** (o valor original do
  título) pra 2.247/2.523 (89%) dos títulos com parcial, e pra 14.099/15.213
  (92,7%) dos títulos sem parcial — os desvios são explicados por `Desconto`
  (concessão comercial) e `ValorCobradoJuros` (juros de atraso somado). Isso é
  matematicamente sólido e consistente em toda a base — não é coincidência.
- `CR_Titulos.Situacao='P'` + `DataQuitacao IS NOT NULL` é o sinal mais
  confiável de "título quitado" a nível de venda (100% correlacionado).

## O que NÃO se sustenta — testado e descartado nesta rodada

**Hipótese testada**: já que `ValorPago + ValorParcialmentePago = ValorDuplicata`
faz sentido matemático do lado NetVision, comparar `contas_financeiras.valor_pago`
(Vivenzza) contra essa SOMA (em vez de só `ValorPago`) deveria reduzir os
conflitos.

**Resultado real, testado contra as 17.783 linhas comparáveis**: a soma
gera **2.448 divergências** — pior que `ValorPago` sozinho (que já tinha ~115-198
antes de qualquer mudança) e pior que a tentativa anterior com
`ValorParcialmentePago` sozinho pros títulos com parcial (que gerava 2.384
quando generalizada).

**Por quê**: a pergunta "o que o NetVision quer dizer com esses dois campos" e
a pergunta "o que o Vivenzza consegue comparar contra eles" são coisas
diferentes. `calcularValorPagoLegado()` (a função que popula
`contas_financeiras.valor_pago` no sync real) **só lê `ValorPago`, nunca soma
`ValorParcialmentePago`** — então o campo do Vivenzza é estruturalmente
incompleto pra qualquer título com histórico de pagamento parcial (falta
somar R$311.681,89 no agregado, segundo a soma de `ValorParcialmentePago` em
toda a base). Trocar só a fórmula de COMPARAÇÃO pra uma soma que o SYNC nunca
produziu não fecha nada — só desloca o descompasso.

## Conclusão honesta desta rodada

1. A semântica NetVision (`ValorPago`=pagamento final, `ValorParcialmentePago`=
   parciais acumulados, soma≈valor original) está bem estabelecida, com alta
   confiança.
2. **Isso NÃO resolve, sozinho, a comparação com o Vivenzza** — o gap real
   está em `calcularValorPagoLegado()`/no job de sync
   (`sync-financeiro-legado.js`, fora deste repositório) nunca ter somado
   `ValorParcialmentePago` ao popular `valor_pago`.
3. **Corrigir isso é uma mudança na lógica de SYNC de produção, não na lógica
   de auditoria/comparação** — mudar só o script de auditoria (como as duas
   tentativas anteriores fizeram) não é suficiente e continuará gerando
   comparações inconsistentes com o dado real do Vivenzza.
4. Nenhuma mudança foi aplicada nesta rodada — nem no sync, nem na auditoria,
   nem em nenhum título. `audit-netvision-financeiro.mjs` continua usando
   só `ValorPago`, como já validado e usado desde o início.

## Recomendação pra próxima rodada (não executada aqui)

Se a decisão de negócio for "Vivenzza deve refletir o total realmente
recebido, incluindo pagamentos parciais", a correção precisa acontecer em
duas camadas, nesta ordem:
1. **Sync** (`calcularValorPagoLegado`/job de produção): somar
   `ValorParcialmentePago` a `ValorPago` ao calcular o valor pago — com
   tratamento dos casos de desconto/juros que hoje explicam ~10-11% dos
   desvios da soma simples.
2. **Só depois** disso rodar de novo, a auditoria vai naturalmente achar
   muito menos divergência — não precisa (nem deve) mudar a lógica de
   comparação isoladamente antes do sync ser corrigido.

Isso é uma mudança real em produção — precisa de autorização explícita
separada, não incluída nesta rodada.
