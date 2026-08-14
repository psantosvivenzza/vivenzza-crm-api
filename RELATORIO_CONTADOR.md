# Relatório para o contador — Numeração fiscal Vivenzza

Documento pra levar à reunião com o contador. Não é uma recomendação de número —
é o levantamento técnico do que existe hoje no sistema, pra decidir junto com
quem tem visão contábil/fiscal completa da empresa.

## A pergunta que precisamos responder

**Qual série e qual próximo número fiscal oficial devem ser usados pelo
Vivenzza para assumir a emissão sem conflito com a NetVision?**

## Situação atual

O Vivenzza CRM tem um sistema de emissão de NF-e pronto no código, mas a
emissão real está **desligada** por uma trava deliberada
(`configuracoes_fiscais.serie1_numeracao_liberada = false`) — ninguém decidiu
ainda qual número usar, então o sistema não deixa emitir de verdade. Nenhuma
nota fiscal real foi emitida pelo Vivenzza até hoje (2026-08-14) além de 1
registro que parece ser um teste (valor R$100,00).

## Séries encontradas na base (10.588 registros — importação histórica do
NetVision, não emissão do Vivenzza)

| Série | Registros | Menor número | Maior número | Rascunho | Autorizada | Cancelada | Outra |
|---|---|---|---|---|---|---|---|
| **1** | 3.535 | -1.066 | 5.241.175 | 3.378 | 1 | 156 | 0 |
| **99** | 6.862 | 0 | 7.107 | 6.811 | 0 | 50 | 1 (emitida interna) |
| 0 | 81 | 1.548 | 12.207.596 | 81 | 0 | 0 | 0 |
| 2 | 24 | 5.693 | 1.979.013 | 24 | 0 | 0 | 0 |
| 3 | 44 | 122.538 | 1.860.117 | 44 | 0 | 0 | 0 |
| 5 | 3 | 799 | 1.103.373 | 3 | 0 | 0 | 0 |
| 10 | 4 | 51.859 | 73.198 | 4 | 0 | 0 | 0 |
| 33 | 1 | 464.159 | 464.159 | 1 | 0 | 0 | 0 |
| 55 | 31 | 15.004 | 21.691 | 31 | 0 | 0 | 0 |
| 890 | 3 | 26.473.415 | 41.410.219 | 3 | 0 | 0 | 0 |

**Só as séries 1 e 99 têm volume relevante.** As demais (0, 2, 3, 5, 10, 33,
55, 890) têm números claramente fora de qualquer faixa fiscal real (ex.
série "890" com número na casa dos 41 milhões) — são artefato da forma como
os dados antigos foram importados/normalizados, não séries fiscais que a
empresa realmente usa.

## Quais são legado/importação vs. realmente autorizadas

**Todos os 10.588 registros vieram de uma única carga histórica do
NetVision** (importados entre 22/07 e 03/08/2026, todos de uma vez — não é
emissão contínua). Dentro deles:

- **1 nota "autorizada" de verdade** (série 1) — mas o nome do destinatário
  está mascarado como teste e o valor é R$100,00, então não parece ser uma
  venda real.
- **1 nota "emitida interna"** (série 99).
- **Todo o resto (10.586 registros) nunca foi transmitido a nenhum fisco** —
  ficou como rascunho ou foi marcado como cancelado na importação.

## Inconsistências de numeração

- Série 1 tem número **negativo** (-1.066) na base, o que não existe numa
  numeração fiscal real — é artefato de importação.
- Série 1 vai até 5.241.175, mas com só 3.535 registros — ou seja, a
  numeração "pula" enormemente (não é sequencial na base importada).
- Série 99 tem uma faixa bem mais coerente (0 a 7.107, com quase o mesmo
  número de registros) — mas a origem interna dessa série ("notas internas",
  segundo a estrutura do sistema legado) precisa ser confirmada com quem
  conhece a operação: não sabemos, só olhando o banco, se é uma série fiscal
  de verdade ou um controle paralelo do NetVision.

**Recomendação técnica (sem decidir o número)**: nenhuma das duas séries
(1 ou 99) tem, hoje, uma numeração limpa e confiável o bastante pra simplesmente
"continuar de onde parou" sem checagem humana. A decisão de qual série usar e
qual o próximo número seguro **precisa vir de quem consegue confirmar, junto à
SEFAZ ou ao sistema NetVision ao vivo, qual foi a última NF-e realmente
autorizada e não cancelada da empresa** — esse dado não está disponível de
forma confiável só pela base importada.

## Ambiente fiscal atual

- **Produção real: desligada.** A variável que decide o ambiente
  (`NFE_AMBIENTE`) não está configurada — por padrão de segurança, o sistema
  cai em **homologação** (ambiente de teste da SEFAZ), nunca em produção,
  enquanto isso não for decidido e configurado explicitamente.
- Certificado digital (.pfx) e senha estão configurados no ambiente de
  produção (Railway), mas — achado à parte, de segurança, não fiscal — a
  senha atual precisa ser trocada antes de qualquer teste real (mais
  detalhes com o time técnico, não é um problema de numeração).

## Situação da série 1

É a série mais "fiscal" das encontradas (contém as NF-e reais antigas
importadas do NetVision, incluindo a única autorizada de verdade). É
justamente por isso que está travada (`serie1_numeracao_liberada=false`) —
ninguém quer o sistema começando a emitir na série errada ou repetindo um
número já usado de verdade pela empresa.

## O que NÃO foi feito

- Nenhuma nota fiscal foi emitida.
- Nenhuma configuração fiscal foi alterada.
- Nenhum número foi escolhido ou sugerido como "o número certo".
