# VIVENZZA-PAYMENT-SWEEP-RESILIENCE-20261015

Marco local em 15/10/2026. Base: commit local
442f4e81cd46a10d7bd8b45d9d0bbd0f7c6a0d91, pacote guards anterior.
Branch exclusiva codex/payment-sweep-resilience-20261015.

## Problema e comportamento

Uma falha ao reconciliar um título interrompia o loop, impedindo os seguintes.
Agora as falhas por título são preservadas e o loop continua. Ao final, qualquer
falha gera AggregateError com código PAYMENT_RECONCILIATION_PARTIAL_FAILURE,
causas originais e resumo numérico. Não há log falso de conclusão bem-sucedida.
Mensagem principal contém somente contagens, sem IDs ou detalhes de títulos.
Erros globais de descoberta continuam abortando antes da reconciliação.
Quando tudo funciona, o retorno público anterior é preservado.

## Evidências

- Três regressões falharam antes da correção; após correção e caso de sucesso,
  52/52 testes afetados passaram, exit 0, sem banco, sockets ou contatos.
- Mocks ficam nas fronteiras; cliente PostgREST real e adaptador SQL real foram
  exercitados com transportes/drivers simulados.
- git diff --check: exit 0.
- Revisão Claude somente leitura: exit 0, SEM ACHADOS BLOQUEANTES. Relatório
  docs/evidence/claude-payment-sweep-review-20261015.json.
- Codex verificou que o try/catch abrange somente a reconciliação por título,
  mantendo falha global de descoberta e o contrato sem falhas. Cron já captura
  somente error.message e usa noOverlap.

## Limitações avaliadas

Falha sistêmica iniciada durante o loop pode consumir timeouts dos títulos
restantes. Não foi introduzido limite arbitrário ou classificação nova de falha
global neste incremento; monitorar duração e sobreposição antes de considerar
política de interrupção. As causas originais não devem ser serializadas no log:
podem conter detalhes sensíveis. O cron atual imprime apenas a mensagem principal.
quitados representa títulos cuja reconciliação terminou sem erro; mutação parcial
de um título que depois falhou não é contada como conclusão. Esse título exige
inspeção; nenhum mecanismo de reversão ou compensação financeira foi adicionado.

Implementado, testado e revisado localmente. Não publicado ou validado em produção.
Não houve contato, sync manual, operação financeira real, merge ou deploy.
