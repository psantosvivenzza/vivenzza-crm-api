# Ambiente de desenvolvimento local — suíte de cobrança

## Por que não é o stack padrão do Supabase CLI

`supabase start` exige Docker/WSL. Em máquinas sem isso disponível, a suíte de
testes de cobrança (`scripts/tests/collection/`) usa em vez disso:

- **PostgreSQL 17+ nativo**, rodando como instância separada e self-contained
  em `.localdev/pgdata`, porta **5433** por padrão (nunca conflita com um
  Postgres do sistema, se existir) — escuta exclusivamente em `127.0.0.1`.
- **Compat client em Node puro** (`src/lib/localdev/pgCompatClient.js`), que
  fala diretamente com esse Postgres via `pg`, implementando o subconjunto de
  métodos do `supabase-js` usado pelo código real (`select/eq/neq/in/gte/lte/
  gt/lt/like/ilike/order/range/limit/maybeSingle/single/insert/update/upsert/
  delete/rpc`). A aplicação roda sem nenhuma alteração — `supabase-admin.
  server.js` decide, na inicialização, se usa o Supabase real ou o compat
  client local, com base em `LOCAL_PG_URL` estar definida (nunca em produção).
- `supabase/migrations/` segue a convenção oficial — se Docker/WSL forem
  instalados no futuro, `supabase start` funciona contra os mesmos arquivos.

## Requisitos

- PostgreSQL 17 (ou compatível) instalado, com `pg_ctl`/`psql` acessíveis via
  `PATH` ou apontados explicitamente por `LOCAL_PG_BIN`.

## Setup

```bash
npm install
# Se pg_ctl/psql não estiverem no PATH:
export LOCAL_PG_BIN="/caminho/para/postgresql/bin"   # Windows: "C:\Program Files\PostgreSQL\17\bin"
```

## Ciclo do dia a dia

```bash
npm run db:local:start    # sobe o Postgres local (idempotente)
npm run db:local:reset    # apaga, recria, aplica TODAS as migrations + seed sintético — do zero
npm run test:collection   # testes de integração reais (node:test, um processo por arquivo)
npm run db:local:stop     # para o Postgres local
```

`npm run test:collection` roda cada arquivo de `scripts/tests/collection/*.test.mjs`
como processo separado (nunca em paralelo — vários testes compartilham estado
no Postgres local), com `NODE_ENV=test` definido. Depende só do Postgres
local + Fake Evolution (`scripts/tests/fakes/fakeEvolution.js`) — zero
dependência externa, zero chamada real ao Supabase/Evolution/WhatsApp.

## Segurança: por que os testes nunca tocam produção

`src/lib/supabase-admin.server.js` é fail-closed: com `NODE_ENV=test`, se
`LOCAL_PG_URL` não estiver definida (setup esquecido, ordem de import errada),
o processo ABORTA em vez de cair silenciosamente pro Supabase real — mesmo
que o `.env` local tenha credenciais reais. `LOCAL_PG_URL` também só é aceita
se apontar pra um host de loopback (`127.0.0.1`/`localhost`/`::1`).

## Config configurável via env

| Variável | Default | Uso |
|---|---|---|
| `LOCAL_PG_BIN` | resolvido via `PATH`, com fallback Windows | diretório com `pg_ctl`/`psql` |
| `LOCAL_PG_DATA` | `.localdev/pgdata` | data directory do cluster local |
| `LOCAL_PG_PORT` | `5433` | porta do Postgres local |
| `LOCAL_PG_DATABASE` | `vivenzza_dev` | nome do banco local |
| `LOCAL_PG_PASSWORD` | `localdev_only_2026` | senha do Postgres local (loopback only, não é segredo de produção) |

## Achados de infraestrutura conhecidos

1. **`localhost` pode resolver mais devagar que `127.0.0.1`** em alguns
   ambientes Windows — os scripts locais usam `127.0.0.1` explicitamente.
2. **`pg` (node-postgres) exige `JSON.stringify` explícito para valores
   jsonb** — arrays JS são serializados como array literal do Postgres por
   padrão, não JSON; o compat client já trata isso.
3. **`pg.Pool` sem `allowExitOnIdle: true` mantém o processo Node vivo
   indefinidamente** mesmo depois de todas as queries terminarem — o compat
   client já usa essa opção.
