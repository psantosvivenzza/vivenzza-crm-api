# Testes unitários sem serviços

Execute `node --test scripts/tests/unit/*.test.mjs` na raiz do worktree.
Esses testes não precisam de Postgres nem carregam credenciais de ambiente.

## Validação da preparação de fixtures financeiras

`fixture-result.test.mjs` verifica propagação explícita de falhas (incluindo
23503), builders thenable e preservação da causa. A integração correspondente
é `scripts/tests/collection/sync-financeiro-telefone-propagacao.test.mjs`.

Em 07/09/2026, o teste de propagação passou num cluster exclusivo, seguido
da execução sequencial de `sync-financeiro-erro-persistencia.test.mjs` e
propagação novamente: seis cenários de persistência e cinco de propagação.
A falha histórica de FK não foi reproduzida nesse banco limpo. Isto não
equivale a aprovação da suíte collection inteira nem correção comprovada
de todos os resíduos do banco compartilhado.

Para repetir integração em outro worktree, escolha cluster, porta e banco
exclusivos via `LOCAL_PG_DATA`, `LOCAL_PG_LOG`, `LOCAL_PG_PORT` e
`LOCAL_PG_DATABASE`. Confira `SHOW data_directory` e `current_database()`
antes de qualquer reset. `localdb-reset.mjs` apaga o banco configurado.
Exporte também `LOCAL_PG_URL` para a suíte completa: alguns testes usam um
fallback fixo se essa variável estiver ausente. Nunca use o banco de outro
desenvolvedor ou o checkout do Task Scheduler para esses testes.

## Suíte completa (`npm run test:collection`), 07/09/2026

A falha histórica de FK FOI reproduzida rodando a suíte completa (56
arquivos) contra o cluster exclusivo reutilizado de execuções anteriores:
`sync-financeiro-telefone-propagacao.test.mjs` falhava com `23503` ao
tentar apagar contas `cr-999%` remanescentes de uma execução anterior,
porque os testes `collection-shadow-*` (que rodam antes em ordem
alfabética) processam a carteira inteira e recalculam
`collection_recovery_scores`/`collection_priority_scores`/`nba_shadow_log`
para qualquer conta ainda presente, inclusive as remanescentes. Corrigido
em `limparTudo()`: apaga essas três tabelas dependentes pelos ids das
contas `cr-999%` antes de apagar as contas. Validado duas vezes: isolado
contra o banco já contaminado (6/6 testes) e na suíte completa inteira
(56/56 arquivos, 0 falhas) após reset limpo do banco.

Achado à parte, sem correção de código: rodar a suíte completa DUAS vezes
seguidas no mesmo banco (sem `db:local:reset` entre as execuções) produziu
6 arquivos com falha, em dois mecanismos distintos — nenhum confirmado
como bug de produto, já que nenhuma asserção sobre comportamento real
chegou a rodar:

- `collection-shadow-queue`, `collection-shadow-reports-large-portfolio`,
  `collection-shadow-reports-postgrest-pagination`: acúmulo real de linhas
  entre execuções (carteira e `collection_dispatches` maiores do que o
  esperado) quebra asserções de contagem/índice exatos.
- `financeiro-promessa-operador`, `promise-expiry-timezone-boundary`,
  `whatsapp-global-rate-limit`: violação de unicidade
  `clientes_erp_legacy_id_unique` (23505) já na preparação do fixture, antes
  de qualquer asserção do teste em si. Hipótese corroborada mas NÃO
  confirmada (o gerador exato não foi rastreado): os três arquivos usam
  `mock.timers.enable({ apis: ['Date'], now: <instante fixo> })` para
  congelar o relógio em cenários de fronteira BRT/UTC; se algum gerador de
  id de fixture depende de `Date.now()`/`new Date()`, o relógio congelado
  produziria o mesmo id a cada execução, colidindo com a linha residual da
  execução anterior.

Nenhuma dessas falhas se repetiu numa execução única contra banco
recém-resetado (56/56 arquivos, 0 falhas). Não foram investigadas a fundo
nem corrigidas nesta rotina. Rode `db:local:reset` antes de cada execução
completa da suíte.
