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
