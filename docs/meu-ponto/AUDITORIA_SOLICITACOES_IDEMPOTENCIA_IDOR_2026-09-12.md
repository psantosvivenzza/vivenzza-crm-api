# Auditoria e correção — IDOR na idempotência de POST /solicitacoes (2026-09-12)

Follow-up dedicado ao achado relacionado que a auditoria adversarial do
componente de equipamento (PR #81) documentou como **fora de escopo** por
pertencer a outro domínio (a rota `/solicitacoes` é pré-existente da PR #78,
não faz parte do componente de equipamento) — corrigido aqui numa PR
separada e pequena, por instrução do projeto (não misturar domínios/PRs).

**Base desta PR:** `codex/meu-ponto-backend-20260910` (PR #78), não a
branch da PR #81 — os dois achados (marcações e solicitações) são
corrigidos em PRs empilhadas independentes sobre a mesma base, evitando
qualquer mistura entre elas.

## Achado confirmado e corrigido

### Troca de usuário via idempotência em `POST /api/ponto/solicitacoes`

**Onde:** `src/routes/ponto.js`, checagem de idempotência no topo do
handler de `POST /solicitacoes`.

**O que havia:** a consulta que decide se um `operacao_id` já tem
solicitação registrada filtrava **só por `operacao_id`**, sem exigir
`usuario_id = req.user.id`. Esse retorno antecipado acontece **antes** da
verificação de senha. Dois ataques possíveis para um colaborador
autenticado que descobrisse (log, captura de tela, URL, retry visível no
devtools) o `operacao_id` de outro colaborador — **sem precisar da senha
correta de ninguém**:

1. **Reutilização/leitura:** se `tipo` e `justificativa` (texto livre)
   coincidissem exatamente com os da vítima, a resposta 200 devolvia
   `id` e `status` da solicitação **alheia**, tratada como se fosse a do
   próprio atacante (`idempotente: true`).
2. **Oráculo de existência:** mesmo sem acertar `tipo`/`justificativa`
   exatos, a resposta 409 ("conteúdo diferente") já confirmava que aquele
   `operacao_id` pertencia a alguém — vazando esse fato sem senha válida.

A exploração do caso 1 é mais difícil que o achado análogo em
`/marcacoes` (que só exigia acertar 1 de 4 valores de `tipo`), porque
`justificativa` é texto livre — mas o caso 2 (oráculo de existência) não
depende de acertar `justificativa` nenhuma, só do `operacao_id`.

**Correção aplicada:** adicionado `.eq('usuario_id', req.user.id)` à
consulta de idempotência (mesma correção já aplicada em `/marcacoes` pela
PR #81). Com o filtro, uma tentativa de reenvio de `operacao_id` alheio
simplesmente não encontra nada sob o `usuario_id` do atacante e cai no
fluxo normal de validação (senha), que rejeita corretamente.

**Prova:** `scripts/tests/ponto/auditoria-solicitacoes-idor-http.test.mjs`,
4 testes via HTTP real (não via camada de serviço):

1. Troca de usuário via idempotência (achado 1 acima) — reproduzido
   **antes** da correção contra o código real: falhou (200, com
   `id`/`status` da vítima, mesmo com senha do atacante propositalmente
   errada). Depois da correção: passa (401, sem nenhum campo da
   solicitação da vítima na resposta).
2. Oráculo de existência entre usuários (achado 2 acima) — reproduzido
   **antes** da correção: falhou (409, confirmando a existência do
   `operacao_id` alheio sem senha correta). Depois da correção: passa
   (401, fluxo normal de criação, nenhuma confirmação de existência).
3. Regressão: idempotência legítima do próprio usuário (retry/timeout/
   duplo clique) continua funcionando após a correção.
4. Concorrência real: dois usuários diferentes reivindicando o mesmo
   `operacao_id` simultaneamente — o `UNIQUE INDEX` real do Postgres em
   `operacao_id` (global, migration 049) garante que só uma das duas
   corridas grava a linha; a outra falha explicitamente (500, violação de
   unicidade real, código `23505`) — nunca lê nem reutiliza a linha do
   vencedor. Esse caso extremo (colisão real de UUID entre usuários
   diferentes, exigindo senha correta de ambos) já existia antes desta
   correção e não foi alterado — está fora do escopo deste achado
   (autorização), é uma falha explícita e segura (fail-closed), mesmo
   tratamento que a PR #81 já deixou como está para `/marcacoes`.

Suíte completa do módulo "Meu Ponto" (14 arquivos, incluindo o novo)
rodada contra um cluster Postgres **exclusivo** deste worktree
(`127.0.0.1:55497`, `meu_ponto_solicitacoes_idor_test`, data dir em
`.localdev/pgdata-solicitacoes-idor` — nunca `5432`/`5433`/`vivenzza_dev`):
**0 falhas**.

## Estado preservado (nada mudou aqui)

- `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` continua `false` em
  `src/lib/ponto/equipamento.js` — não tocado por esta correção.
- `ponto_config.piloto_ativo` continua `false` por padrão em toda
  migration/reset — só ligado deliberadamente pelos próprios testes,
  dentro do cluster isolado, nunca fora dele.
- Nenhuma migration nova, nenhuma migration aplicada em produção/staging,
  nenhum bucket real tocado, nenhuma instalação em máquina real, nenhum
  merge, nenhum deploy.
- Nenhum arquivo de Financeiro/Fiscal/WhatsApp/Voz/Scheduler tocado.
- Nenhum arquivo do componente de equipamento (`ponto-equipamento.js`,
  `equipamentoService.js`, `assinaturaEquipamento.js`, migrations
  052/053) tocado — aquele domínio é tratado só pela PR #81.

## Como reproduzir

```bash
# Cluster Postgres exclusivo (nunca 5432/5433/vivenzza_dev) — exemplo
# usado nesta correção, ajuste porta/dir conforme necessário:
LOCAL_PG_DATA=".localdev/pgdata-solicitacoes-idor" LOCAL_PG_PORT=55497 \
  LOCAL_PG_DATABASE=meu_ponto_solicitacoes_idor_test node scripts/localdb-start.mjs
LOCAL_PG_DATA=".localdev/pgdata-solicitacoes-idor" LOCAL_PG_PORT=55497 \
  LOCAL_PG_DATABASE=meu_ponto_solicitacoes_idor_test node scripts/localdb-reset.mjs

PONTO_TEST_PG_PORT=55497 PONTO_TEST_PG_DATABASE=meu_ponto_solicitacoes_idor_test \
  npm run test:ponto
```
