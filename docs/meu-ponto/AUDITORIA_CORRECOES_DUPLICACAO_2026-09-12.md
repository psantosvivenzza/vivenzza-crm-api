# Auditoria adversarial independente — duplicação em POST /correcoes (2026-09-12)

Auditoria adversarial independente da PR `vivenzza-crm-api#78`, motivada
pelo achado documentado na PR frontend `vivenzza-crm-frontend#19`: `POST
/api/ponto/correcoes` não usava `operacao_id` nem `exigirPilotoAtivo`, ao
contrário de `/marcacoes` e `/solicitacoes`.

**Base desta PR:** `codex/meu-ponto-backend-20260910` (PR #78), não as
branches das PRs #81/#82 (achados independentes, em outras duas rotas do
mesmo módulo) — os três achados são corrigidos em PRs empilhadas
independentes sobre a mesma base, por instrução do projeto (não misturar
domínios/correções na mesma PR).

## Estado confirmado no início desta auditoria

- **PR #78** (`vivenzza-crm-api`, `codex/meu-ponto-backend-20260910` →
  `main`): OPEN, 2 commits, `HEAD=366e271`. `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA=false`,
  `ponto_config.piloto_ativo` default `false` em toda migration.
- **PR #19** (`vivenzza-crm-frontend`, `codex/meu-ponto-correcao-ui-20260912`
  → `codex/meu-ponto-frontend-20260910`): OPEN, empilhada sobre a #18
  (draft). Corpo da PR já documenta, por leitura de código (não é
  suposição), as duas diferenças de contrato entre `/correcoes` e as
  outras rotas do módulo — exatamente o gatilho desta auditoria.
- Confirmado por leitura direta de `src/routes/ponto.js` (branch da PR
  #78, antes de qualquer alteração): `router.post('/correcoes', async
  (req, res) => {...})` sem `exigirPilotoAtivo` no meio da assinatura (ao
  contrário de `/marcacoes` e `/solicitacoes`, que têm
  `exigirPilotoAtivo, limiteTentativasSensiveis`) e sem nenhuma leitura de
  `operacao_id` no corpo. `supabase/migrations/20260101000048_meu_ponto_piloto.sql`
  confirma: `ponto_correcoes` não tinha coluna `operacao_id` nem qualquer
  `UNIQUE`/índice de idempotência — diferente de `ponto_marcacoes` e
  `ponto_solicitacoes_marcacao` (migration 049), que sempre tiveram.

## Metodologia

Cluster Postgres **exclusivo** deste worktree
(`127.0.0.1:55491`/`meu_ponto_test`, data dir
`.localdev/pgdata-ponto-audit`, nunca `5432`/`5433`/`vivenzza_dev`) — baseline
+ todas as migrations reais aplicadas do zero. Reprodução em duas etapas:

1. Script de reprodução ad-hoc (fora da suíte, descartado) rodando os 6
   cenários pedidos diretamente via HTTP real (`chamar()` do harness de
   teste, nunca camada de serviço direta) contra o código **não
   corrigido**, para confirmar ou descartar cada um por evidência, não por
   leitura de código isolada.
2. Suíte oficial completa (`npm run test:ponto`) rodada antes e depois da
   correção — `99` testes / `0` falhas antes (confirma a alegação da PR
   #78), `110` testes / `0` falhas depois (99 + 1 arquivo novo de 8
   testes, mais 2 testes adicionados ao arquivo já existente).

## Achado confirmado e corrigido: duplicação garantida sob retry/timeout e concorrência

**Onde:** `src/routes/ponto.js`, `POST /api/ponto/correcoes`;
`supabase/migrations/20260101000048_meu_ponto_piloto.sql`, tabela
`ponto_correcoes`.

**O que havia:** a rota fazia um `INSERT` direto em `ponto_correcoes` sem
nenhuma chave de idempotência — nem `operacao_id` no corpo da requisição,
nem coluna correspondente no banco, nem `UNIQUE INDEX`. Reproduzido contra
o código real, antes de qualquer alteração:

- **Retry sequencial** (2 chamadas HTTP idênticas, uma após a outra,
  simulando um timeout ambíguo de rede seguido de nova tentativa do
  cliente): **2 linhas** criadas em `ponto_correcoes` para a mesma
  marcação, mesmo `tipo_solicitacao`, mesmo `valor_proposto`, mesma
  justificativa.
- **Concorrência real** (5 requisições HTTP simultâneas, mesmo conteúdo,
  via `Promise.all`): **5 linhas** criadas.

Isso é estruturalmente diferente do problema já corrigido pelas PRs #81/#82
(vazamento de dados entre usuários numa checagem de idempotência que já
existia) — aqui a checagem de idempotência **nunca existiu** para esta
rota. O risco não é hipotético nem depende de regra trabalhista: um duplo
clique, uma aba duplicada, um timeout de rede seguido de nova tentativa
manual (a própria PR #19 documenta que o frontend, sabendo dessa lacuna,
**evita retry automático** e avisa o usuário do risco de duplicar antes de
deixá-lo reenviar manualmente) geram duas solicitações de correção
pendentes para a mesma marcação. Na pior consequência prática, um gestor
que decida as duas — cada uma parecendo, à primeira vista, uma solicitação
legítima e independente — pode aprovar ambas, gerando **duas** novas
linhas em `ponto_marcacoes` (`origem='correcao'`) para o que era, na
realidade, uma única correção pretendida. Isso é o mesmo tipo de defeito
de integridade que a segunda revisão da PR #78 já tratou como "concreto"
para a aprovação silenciosa sem marcação — aqui a superfície é a
duplicação da própria solicitação, não da aprovação.

**Correção aplicada:** mesmo padrão de `/marcacoes` e `/solicitacoes`
(seção 2.3 da especificação):

- `ponto_correcoes.operacao_id uuid NOT NULL UNIQUE` adicionado à
  migration 048 (tabela nunca foi aplicada em nenhum ambiente real — ver
  "Estado preservado" abaixo; editada em vez de empilhar uma migration
  nova, mesmo critério já usado pela própria PR #78 para as migrations
  051/053 no commit `366e271`).
- `POST /api/ponto/correcoes` agora exige `operacao_id` (UUID v4,
  validado com a mesma regex das outras rotas), consulta a idempotência
  **antes** de qualquer validação de posse da `marcacao_id`, compara o
  conteúdo completo (`marcacao_id`, `tipo_solicitacao`, `justificativa`,
  `valor_proposto` — comparação estrutural, ignorando ordem de chaves do
  JSON) e devolve 200 com a correção já existente em caso de retry
  idêntico, ou 409 (`operacao_id_conteudo_diferente`, mesma mensagem já
  usada pelas outras rotas) em caso de conteúdo divergente sob a mesma
  chave.
- A consulta de idempotência já nasce filtrada por `usuario_id =
  req.user.id` — a classe de vazamento entre usuários corrigida
  separadamente pelas PRs #81/#82 para `/marcacoes` e `/solicitacoes`
  nunca chegou a existir aqui, porque a idempotência inteira é código
  novo desta correção.
- Corrida real entre duas requisições do MESMO usuário (SELECT de
  idempotência não encontra nada para nenhuma das duas, ambas tentam
  `INSERT`): capturado o código `23505` (violação de `UNIQUE` real do
  Postgres) e a vencedora é buscada e devolvida como 200 idempotente, em
  vez de um 500 espúrio para o caso legítimo mais comum (retry/duplo
  clique do próprio usuário).
- Colisão real de `operacao_id` entre usuários **diferentes**
  (astronomicamente improvável em uso legítimo — o cliente gera um UUID
  v4 aleatório por toque) permanece fail-closed (500 explícito, sem
  vazar/reutilizar a linha do outro usuário) — mesmo critério que as PRs
  #81/#82 já deixaram assim para `/marcacoes`/`/solicitacoes`, não
  alterado aqui.

**Prova:** `scripts/tests/ponto/auditoria-correcoes-duplicacao-http.test.mjs`
(8 testes novos, via HTTP real) + 2 testes adicionados a
`scripts/tests/ponto/correcoes.test.mjs`/`usuario-inativo-todas-rotas.test.mjs`
(payload de `operacao_id` obrigatório em todas as chamadas existentes).
Cobertura: `operacao_id` obrigatório/UUID; retry sequencial idêntico → 1
linha; conteúdo diferente sob o mesmo `operacao_id` → 409, sem sobrescrever
o valor original; concorrência real (5 simultâneas) → 1 linha; idempotência
não vaza entre usuários (revalidação, sem alteração de comportamento).

## Investigado e confirmado SEM defeito (código já correto, nada alterado)

Reproduzido via HTTP real contra o código da PR #78, antes de qualquer
alteração:

- **Correção de marcação alheia:** `POST /correcoes` com `marcacao_id` de
  outro colaborador sempre devolveu `404` ("Marcação não encontrada.") —
  a rota já valida `marcacao.usuario_id === req.user.id` antes do
  `INSERT`. Nenhuma linha criada. Não alterado.
- **Payload forjado:** enviar `status`, `decidido_por`, `decidido_em`,
  `usuario_id`, `solicitado_por` e `marcacao_gerada_id` diretamente no
  corpo da requisição não teve nenhum efeito — a rota só usa
  `req.user.id` (nunca um `usuario_id` do corpo) e literais fixos
  (`status: 'pendente'`) na hora do `INSERT`. Confirmado lendo a linha
  criada de volta no banco. Não alterado.
- **Usuário inativo:** `exigirUsuarioAtivo` é montado em `src/index.js`
  antes dos três routers do módulo (não dentro de um handler específico),
  cobrindo `/correcoes` como qualquer outra rota — confirmado com `403`
  mesmo com um JWT emitido antes da desativação. Já coberto também por
  `usuario-inativo-todas-rotas.test.mjs`. Não alterado.
- **Criação com piloto desativado:** confirmado que `POST /correcoes`
  continua respondendo `201` com `ponto_config.piloto_ativo=false`. **Não
  é um defeito** — é a seção 4 (Permissões) da especificação, que já lista
  "solicitar correção" como capacidade do colaborador habilitado **sem** a
  condicional "(se `piloto_ativo` = true)" que aparece explicitamente só
  para "enviar solicitação de marcação"; a seção 2.3 (idempotência) também
  só cita "marcação (...) ou solicitação" ao definir o escopo de
  `operacao_id` antes desta correção, nunca "correção". Não inventamos
  regra de negócio nova aqui: o comportamento atual já era a especificação
  documentada, e o frontend (PR #19) já implementou o botão "Solicitar
  correção" sempre habilitado, consistente com isto. Documentado como
  teste de regressão intencional (`auditoria-correcoes-duplicacao-http.test.mjs`)
  para sinalizar qualquer mudança futura que precise de decisão de negócio
  explícita — comportamento **não alterado** por esta PR.

## Estado preservado (nada mudou aqui)

- `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` continua `false` em
  `src/lib/ponto/equipamento.js` — não tocado.
- `ponto_config.piloto_ativo` continua `false` por padrão em toda
  migration/reset — só ligado deliberadamente pelos próprios testes,
  dentro do cluster isolado, nunca fora dele.
- Nenhuma migration nova adicionada (a 048 foi editada em vez de
  empilhada — nunca aplicada em produção/staging, mesmo critério já usado
  pela PR #78 para as migrations 051/053); nenhum bucket real tocado,
  nenhuma instalação em máquina real, nenhum merge, nenhum deploy.
- Nenhum arquivo de Financeiro/Fiscal/WhatsApp/Voz/Scheduler tocado.
- Nenhum arquivo do componente de equipamento nem de `/marcacoes`/
  `/solicitacoes` tocado além do necessário (`mensagemAmigavelRegistro`,
  já existente, reaproveitada sem alteração).

## Impacto necessário na PR #19 (frontend) — decisão/ação pendente lá, não aqui

Esta correção **muda o contrato** de `POST /api/ponto/correcoes`:
`operacao_id` (UUID v4) agora é **obrigatório** (`400` se ausente ou
inválido) — antes não existia no contrato. A PR #19 (`pontoCorrecao.js` /
`ModalSolicitarCorrecao`) hoje **não envia** `operacao_id` no payload (o
próprio corpo da PR #19 documenta isso como diferença deliberada em
relação ao modal de "Solicitar marcação"). Sem atualização, toda chamada
do frontend a `POST /correcoes` passaria a receber `400`.

Ação necessária na PR #19, antes de qualquer merge conjunto:

1. Gerar um `operacao_id` (UUID v4) no cliente no momento do toque no
   botão "Solicitar correção" e incluí-lo no payload — mesmo padrão já
   usado para `/solicitacoes`/`/marcacoes` no restante do frontend.
2. Reavaliar (decisão de produto da PR #19, não desta PR de backend) se o
   aviso de "risco de duplicar sem tentar de novo automático" ainda faz
   sentido do jeito que está — agora que o backend tem idempotência real,
   um retry automático com o MESMO `operacao_id` após um timeout ambíguo
   deixou de arriscar duplicar. Isso é uma melhoria de UX possível, não
   uma obrigação técnica desta correção.
3. A ausência de `exigirPilotoAtivo` em `/correcoes` (botão sempre
   habilitado) **não muda** com esta PR — nenhuma ação necessária na PR
   #19 quanto a isso.

## Como reproduzir

```bash
# Cluster Postgres exclusivo (nunca 5432/5433/vivenzza_dev) — exemplo
# usado nesta auditoria, ajuste porta/dir conforme necessário:
LOCAL_PG_DATA=".localdev/pgdata-ponto-audit" LOCAL_PG_PORT=55491 \
  LOCAL_PG_DATABASE=meu_ponto_test node scripts/localdb-start.mjs
LOCAL_PG_DATA=".localdev/pgdata-ponto-audit" LOCAL_PG_PORT=55491 \
  LOCAL_PG_DATABASE=meu_ponto_test node scripts/localdb-reset.mjs

PONTO_TEST_PG_PORT=55491 PONTO_TEST_PG_DATABASE=meu_ponto_test \
  npm run test:ponto
```
