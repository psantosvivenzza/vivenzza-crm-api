# Auditoria adversarial — fotos, histórico, exportação, gestão e administração (2026-09-12)

Auditoria inédita sobre a pilha combinada #78+#81+#82+#83 (backend "Meu
Ponto"), focada em endpoints de fotos, histórico, exportações, gestão e
administração — complementar às auditorias anteriores (idempotência/IDOR em
`/marcacoes` e `/solicitacoes`, duplicação em `/correcoes`).

**Base desta PR:** `codex/meu-ponto-backend-20260910` (PR #78), não as
branches das PRs #81/#82/#83 — `src/routes/ponto-gestao.js` (arquivo desta
correção) nunca foi tocado por nenhuma das três, confirmado por
`git diff <topo #78> <topo #81+#82+#83> -- src/routes/ponto-gestao.js`
(diff vazio). Corrigir sobre o topo de #78 mantém esta PR pequena,
independente e stacktável sem misturar domínios, conforme instrução do
projeto.

## Cenários auditados (sem defeito encontrado)

Testados via HTTP real contra Postgres isolado, cobrindo lacunas que as
suítes existentes não exercitavam (a listagem com `colaborador_id` e a
decisão já eram testadas; a rota de **foto por ID direto** sob gestão não
era):

- Foto de **marcação** de colaborador fora do escopo do gestor, pedida por
  ID direto em `GET /api/ponto-gestao/marcacoes/:id/foto` → **404**, sem
  vazar URL assinada nem confirmar existência.
- Foto de **solicitação** de colaborador fora do escopo, mesma rota
  equivalente para solicitações → **404**.
- `GET /api/ponto-gestao/correcoes?colaborador_id=<fora>` e
  `GET /api/ponto-gestao/solicitacoes?colaborador_id=<fora>` → **403**.
- Listagens sem filtro (`/correcoes`, `/solicitacoes`) nunca incluem
  colaborador fora do escopo, mesmo quando ele tem dados reais no banco.
- Payload forjado em `POST /correcoes/:id/decisao` (`usuario_id`,
  `decidido_por`, `status` enviados no corpo) — todos ignorados; o servidor
  sempre usa `req.user.id` como decisor e o resultado real da função
  Postgres como status.
- Payload forjado em `POST /api/ponto-admin/equipamentos` (`modo`,
  `status`, `id` enviados no corpo) — todos ignorados; `modo` sempre
  `'demonstracao'`, `id`/`status` sempre gerados pelo servidor.
- Nenhuma resposta de listagem/foto do módulo inclui `senha_hash` ou campo
  de outro usuário fora do escopo.
- ID malformado (não-UUID) em rota de foto não derruba a rota com detalhe
  interno vazado na resposta (a mensagem ao cliente é sempre genérica); o
  único efeito colateral observado é status 500 em vez de 400/404 — sem
  nenhuma confirmação/negação de existência de outro registro. Não corrigido
  aqui por não representar um vazamento de autorização (registrado como
  risco residual de baixa severidade abaixo).

Prova: `scripts/tests/ponto/auditoria-fotos-historico-gestao-admin-20260912.test.mjs`
(12 testes, todos os cenários acima, controle positivo incluso).

## Achado confirmado e corrigido: exportação excessiva sem limite algum

**Onde:** `src/routes/ponto-gestao.js`, `GET /correcoes` e
`GET /solicitacoes`.

**O que havia:** as duas rotas nunca tiveram nenhum parâmetro de
página/limite — diferente de `GET /marcacoes` (mesmo arquivo), que já usa
`pagina`/`limite` com teto de 500. Um gestor com escopo amplo, ou um admin
(`pontoEscopoGestor = null`, sem restrição), recebia a tabela
`ponto_correcoes`/`ponto_solicitacoes_marcacao` **inteira** (dentro do
escopo) numa única resposta HTTP, sem nenhum jeito de o cliente conter o
volume. Confirmado empiricamente: 60 correções pendentes criadas para o
mesmo colaborador voltaram todas de uma vez numa única chamada
`GET /correcoes`, sem paginação disponível.

Risco: uma única requisição autorizada (não é preciso nenhum bypass de
autenticação/escopo) podia extrair um volume não delimitado de dados de
múltiplos colaboradores — vetor de exportação em massa/exaustão de
recursos, inconsistente com o padrão já estabelecido em `/marcacoes`.

**Correção aplicada:** adicionado o mesmo padrão `pagina`/`limite` (teto de
500, igual a `/marcacoes`) às duas rotas, com `total` na resposta para o
cliente detectar truncamento e paginar se precisar. `limite` default é 500
(não 30, como em `/marcacoes`) — generoso o bastante para não mudar o
comportamento observável em qualquer fila de aprovações real; só estabelece
um teto para o caso de volume patológico. O campo `itens` da resposta
continua no mesmo formato (compatibilidade com consumidores atuais).

**Nota para coordenação com o frontend:** `GestaoPonto.jsx` usa estas
listagens para export CSV/PDF (mesmo padrão já documentado para
`/marcacoes` em `usuario-inativo-todas-rotas.test.mjs`). Com teto de 500,
qualquer fila de correções/solicitações pendentes com mais de 500 itens
passaria a ser truncada silenciosamente do ponto de vista do frontend, a
menos que ele já pagine ou passe `limite` maior explicitamente. Não há
como confirmar isso a partir deste repositório (backend); recomenda-se
confirmar com o time de frontend antes do merge — teto generoso (500)
escolhido justamente para tornar esse cenário extremamente improvável na
prática (fila de aprovações pendentes deste porte já seria, por si só, um
sinal operacional a ser investigado).

**Prova:** `scripts/tests/ponto/gestao-limite-listagem-correcoes-solicitacoes.test.mjs`,
5 testes via HTTP real:

1. `limite` sempre clampado em 500, mesmo pedindo um valor maior (as duas
   rotas).
2. Paginação (`pagina`/`limite`) não perde nem duplica itens dentro do
   escopo, somando páginas.
3. Checagem de escopo (`colaborador_id` fora do escopo → 403) continua
   funcionando com o novo parâmetro de paginação.
4. Formato de resposta (`itens` como array) preservado, com os novos campos
   (`total`/`pagina`/`limite`) adicionados de forma aditiva.

Suíte completa do módulo "Meu Ponto" (15 arquivos, incluindo o novo) rodada
contra um cluster Postgres **exclusivo** deste worktree (não
`5432`/`5433`/`vivenzza_dev`): **0 falhas**.

## Risco residual (não corrigido nesta PR, registrado para decisão futura)

- `GET /api/ponto/correcoes` e `GET /api/ponto/solicitacoes`
  (autosserviço, `src/routes/ponto.js`) também não têm paginação — mas o
  escopo é sempre o próprio `usuario_id`, sem exposição cross-usuário;
  impacto limitado ao volume de histórico do próprio colaborador. Não
  corrigido aqui por pertencer a outro arquivo já modificado pelas PRs
  #81/#82/#83 (evitar misturar domínios/PRs, mesma regra que motivou as
  correções anteriores serem PRs separadas).
- ~~ID malformado (não-UUID) em rotas de `.../:id/foto` retorna 500 (erro
  genérico do Postgres, `22P02`, sem detalhe vazado) em vez de 400~~ —
  **corrigido** em PR posterior (validação de formato compartilhada,
  `src/lib/ponto/validacao.js`, aplicada nos três routers do módulo antes de
  qualquer consulta). Ver
  `docs/meu-ponto/CORRECAO_UUID_MALFORMADO_20260912.md`.

## Estado preservado (nada mudou aqui)

- `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` continua `false`.
- `ponto_config.piloto_ativo` continua `false` por padrão fora dos testes.
- Nenhuma migration nova, nenhuma migration aplicada em produção/staging.
- Nenhum arquivo de Financeiro/Fiscal/WhatsApp/Voz/Scheduler tocado.
- Nenhuma mudança em `usuario_id`/autorização/escopo — só limite de itens
  por página.

## Como reproduzir

```bash
LOCAL_PG_DATA=".localdev/pgdata-fix-exportacao" LOCAL_PG_PORT=55523 \
  LOCAL_PG_DATABASE=meu_ponto_fix_exportacao_20260912 node scripts/localdb-start.mjs
LOCAL_PG_DATA=".localdev/pgdata-fix-exportacao" LOCAL_PG_PORT=55523 \
  LOCAL_PG_DATABASE=meu_ponto_fix_exportacao_20260912 node scripts/localdb-reset.mjs

PONTO_TEST_PG_PORT=55523 PONTO_TEST_PG_DATABASE=meu_ponto_fix_exportacao_20260912 \
  npm run test:ponto
```
