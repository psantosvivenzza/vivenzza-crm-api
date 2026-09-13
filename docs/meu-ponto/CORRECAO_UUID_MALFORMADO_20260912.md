# Correção — UUID malformado retornando 500 nas rotas de "Meu Ponto" (2026-09-12)

Continuação da fila de correções sobre a pilha `#78`/`#81`/`#82`/`#83`/`#84`,
fechando o risco residual confirmado em
`docs/meu-ponto/AUDITORIA_FOTOS_HISTORICO_GESTAO_ADMIN_2026-09-12.md`
(seção "Risco residual"): um `:id`/campo que não é um UUID válido chegava a
uma chamada `.eq()`/`.insert()` do PostgREST, o Postgres rejeitava com
`22P02` (`invalid input syntax for type uuid`), e o catch genérico de cada
rota devolvia **500** — status tecnicamente incorreto para "entrada do
cliente é inválida" (deveria ser 400), embora sem vazamento de dado (a
mensagem ao cliente já era sempre genérica).

**Base desta PR:** `fix/ponto-gestao-exportacao-sem-limite-20260912` (PR
`#84`), que por sua vez está sobre `codex/meu-ponto-backend-20260910` (PR
`#78`). `#84` foi escolhida como base (em vez de `#78` direto) porque parte
das rotas corrigidas aqui vive em `src/routes/ponto-gestao.js`, arquivo que
`#84` já modifica (paginação de `/correcoes` e `/solicitacoes`) — corrigir
sobre o topo de `#84` evita um conflito de merge desnecessário entre as duas
PRs. `#81`/`#82`/`#83` não são tocadas nem servem de base (são independentes
entre si e desta, todas irmãs sobre `#78` — ver auditorias anteriores).

## Varredura completa (todos os parâmetros UUID de `/api/ponto`, `/api/ponto-gestao`, `/api/ponto-admin`)

| Rota | Parâmetro | Antes | Depois |
|---|---|---|---|
| `GET /api/ponto/marcacoes/:id/foto` | `:id` (rota) | 500 se malformado | **400** |
| `GET /api/ponto/solicitacoes/:id/foto` | `:id` (rota) | 500 se malformado | **400** |
| `GET /api/ponto/solicitacoes/por-operacao/:operacao_id` | `:operacao_id` (rota) | já validava (400) | sem mudança |
| `POST /api/ponto/correcoes` | `marcacao_id` (corpo, opcional) | 500 se malformado | **400** |
| `GET /api/ponto-gestao/marcacoes/:id/foto` | `:id` (rota) | 500 se malformado | **400** |
| `GET /api/ponto-gestao/solicitacoes/:id/foto` | `:id` (rota) | 500 se malformado | **400** |
| `POST /api/ponto-gestao/correcoes/:id/decisao` | `:id` (rota) | 500 se malformado | **400** |
| `POST /api/ponto-gestao/solicitacoes/:id/decisao` | `:id` (rota) | 500 se malformado | **400** |
| `GET /api/ponto-gestao/marcacoes?colaborador_id=` | `colaborador_id` (query) | 500 se malformado | **400** |
| `GET /api/ponto-gestao/correcoes?colaborador_id=` | `colaborador_id` (query) | 500 se malformado | **400** |
| `GET /api/ponto-gestao/solicitacoes?colaborador_id=` | `colaborador_id` (query) | 500 se malformado | **400** |
| `PATCH /api/ponto-admin/habilitacoes/:usuario_id` | `:usuario_id` (rota) | 500 se malformado | **400** |
| `POST /api/ponto-admin/gestores` | `gestor_usuario_id`/`colaborador_usuario_id` (corpo) | 500 se malformado | **400** |
| `DELETE /api/ponto-admin/gestores/:id` | `:id` (rota) | 500 se malformado | **400** |
| `POST /api/ponto-admin/equipamentos` | `usuario_id` (corpo) | 500 se malformado | **400** |
| `POST /api/ponto-admin/equipamentos/:id/vinculos` | `:id` (rota) | 500 se malformado | **400** |
| `DELETE /api/ponto-admin/equipamentos/:id` | `:id` (rota) | 500 se malformado | **400** |

Rotas revisadas e confirmadas **sem** parâmetro UUID vindo de rota/corpo/query
do cliente (nada a corrigir): `GET /estado`, `GET/POST /marcacoes` (exceto o
`:id/foto` acima), `POST /desafios` e `POST /marcacoes` de `ponto.js` (já
validavam `equipamento_id`/`operacao_id` com o mesmo regex, sem mudança),
`GET /colaboradores`, `PATCH /config`, `GET /habilitacoes`, `GET /gestores`,
`GET /equipamentos`, `GET /config`. `src/routes/ponto-equipamento.js`
(`POST /vincular`) está fora do escopo desta correção — mesmo módulo, mas
montado sem autenticação e sem nenhum `:id`/campo UUID vindo do cliente (a
única credencial é um `codigo` de uso único, não um UUID).

## O que foi corrigido

**Onde:** novo arquivo `src/lib/ponto/validacao.js`, importado pelos três
routers.

```js
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuidValido(valor) { ... }
export function exigirUuidNoParam(nomeParam) { /* middleware — 400 antes de qualquer query */ }
```

Cada `:id`/campo listado na tabela acima passou a ser validado (via o
middleware, para parâmetro de rota, ou uma checagem inline equivalente, para
campo de corpo/query) **antes** de qualquer consulta ao banco.

### Por que isto não cria um oráculo de autorização

A checagem de formato é pura sintaxe — nunca consulta existência nem escopo,
e roda sempre antes de qualquer consulta que dependeria disso. Por isso o
código 400 nunca varia com quem está perguntando nem com o que existe no
banco: um gestor com escopo amplo e um gestor com escopo minúsculo recebem o
mesmo 400 para o mesmo `colaborador_id` malformado. O 404 (rota por id) e o
403 (`colaborador_id` fora do escopo em query) que já existiam **não
mudaram** — continuam sendo a mesma resposta genérica para "não existe" e
"existe mas não é seu", decidida só depois da consulta, exatamente como
antes desta correção. Não foi introduzido nenhum status ou mensagem nova que
diferencie esses dois casos.

## Testes

- `scripts/tests/ponto/uuid-malformado-vs-inexistente.test.mjs` (novo, 18
  testes): para cada rota da tabela acima, dois IDs malformados (um simples,
  um no formato de tentativa de injeção de SQL — `1' OR '1'='1`) sempre 400,
  sem vazar detalhe interno na resposta; e ao lado, um UUID de formato válido
  mas inexistente/fora de escopo continua no código que já existia (404 ou
  403, conforme a rota) — nunca 400. Inclui também um controle positivo
  (`DELETE /equipamentos/:id` com UUID real revoga normalmente).
- `scripts/tests/ponto/auditoria-fotos-historico-gestao-admin-20260912.test.mjs`:
  o teste de "ID malformado nas rotas de foto" (achado original) foi
  endurecido de `[400, 404, 500].includes(status)` para `status === 400`
  exatamente — regressão do achado original agora fechada de verdade, não
  só documentada.

Suíte completa do módulo "Meu Ponto" (16 arquivos, 137 testes) rodada contra
um cluster Postgres **exclusivo** deste worktree (porta `55677`, banco
`meu_ponto_fix_uuid_20260912` — nunca `5432`/`5433`/`vivenzza_dev`): **0
falhas**.

## Risco residual (fora do escopo desta PR, registrado para decisão futura)

- `POST /api/ponto-admin/gestores` e `POST /api/ponto-admin/equipamentos`
  aceitam um UUID de **formato válido** mas que não corresponde a nenhum
  `usuarios.id` real. O `INSERT` viola a FK (`gestor_usuario_id`/
  `colaborador_usuario_id`/`usuario_id REFERENCES usuarios(id)`, migration
  048) e cai no catch genérico → 500 (não 400/404). É uma categoria
  diferente do achado corrigido aqui (existência referencial, não formato) —
  fora do escopo desta correção pontual; registrado para uma PR futura que
  queira tratar violação de FK de forma uniforme no módulo.
- Riscos residuais já registrados na auditoria anterior (paginação de
  `GET /api/ponto/correcoes`/`solicitacoes` de autosserviço) continuam sem
  mudança — não fazem parte desta correção.

## Estado preservado (nada mudou aqui)

- `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` continua `false`.
- `ponto_config.piloto_ativo` continua `false` por padrão fora dos testes.
- Nenhuma migration nova, nenhuma migration aplicada em produção/staging.
- Nenhum arquivo de Financeiro/Fiscal/WhatsApp/Voz/Scheduler tocado.
- Nenhuma mudança em autorização/escopo/idempotência — só validação de
  formato de entrada, sempre antes de qualquer consulta.

## Como reproduzir

```bash
LOCAL_PG_DATA=".localdev/pgdata-fix-uuid" LOCAL_PG_PORT=55677 \
  LOCAL_PG_DATABASE=meu_ponto_fix_uuid_20260912 node scripts/localdb-start.mjs
LOCAL_PG_DATA=".localdev/pgdata-fix-uuid" LOCAL_PG_PORT=55677 \
  LOCAL_PG_DATABASE=meu_ponto_fix_uuid_20260912 node scripts/localdb-reset.mjs

PONTO_TEST_PG_PORT=55677 PONTO_TEST_PG_DATABASE=meu_ponto_fix_uuid_20260912 \
  npm run test:ponto
```
