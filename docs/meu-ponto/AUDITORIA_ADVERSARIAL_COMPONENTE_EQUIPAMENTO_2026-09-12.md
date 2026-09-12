# Auditoria adversarial independente — componente de equipamento (2026-09-12)

Auditoria de segurança sobre o código **real** do componente de
identificação de equipamento da PR #78 (`codex/meu-ponto-backend-20260910`),
feita num worktree isolado, sem depender de nenhuma implementação nova
paralela. Objetivo: revisar linha a linha contra o modelo de ameaça —
replay, troca de usuário/equipamento/operação/conteúdo, desafio expirado,
chave revogada, downgrade de chave hardware-backed, comprometimento local —
e só reportar/corrigir defeitos técnicos comprovados por teste, nunca por
inspeção especulativa.

Esta PR tem como **base a branch da PR #78**
(`codex/meu-ponto-backend-20260910`), não `main` — o diff aqui é só o que
esta auditoria mudou (2 arquivos) e o que ela adicionou (1 arquivo novo de
teste + este documento). Nenhum arquivo da PR #18 (voice workers) foi
tocado.

## Escopo revisado

- `src/lib/ponto/assinaturaEquipamento.js` (primitivas de assinatura/HMAC)
- `src/lib/ponto/equipamentoService.js` (cadastro, desafio, registro)
- `src/lib/ponto/equipamento.js` (gate estrutural)
- `src/routes/ponto.js`, `src/routes/ponto-equipamento.js`,
  `src/routes/ponto-admin.js` (rotas HTTP)
- `supabase/migrations/20260101000052_meu_ponto_componente_equipamento.sql`,
  `..._000053_meu_ponto_registro_assinado.sql`
- `local-equipamento-service/servico.mjs`, `cng-operacoes.ps1`,
  `confirmar.ps1` (cliente Windows local)
- `scripts/tests/ponto/componente-equipamento.test.mjs` e demais testes já
  existentes (lidos por completo antes de escrever qualquer teste novo, para
  não duplicar cobertura)

## Achado confirmado e corrigido

### Troca de usuário via idempotência em `POST /api/ponto/marcacoes`

**Onde:** `src/routes/ponto.js`, checagem de idempotência no topo do
handler de `POST /marcacoes`.

**O que havia:** a consulta que decide se um `operacao_id` já tem marcação
registrada filtrava **só por `operacao_id`**, sem exigir
`usuario_id = req.user.id`. Esse retorno antecipado acontece **antes** da
verificação de senha e **antes** de qualquer verificação de assinatura de
equipamento. Resultado: qualquer colaborador autenticado que descobrisse o
`operacao_id` de outro colaborador (vazamento de log, captura de tela, URL,
etc. — não precisava adivinhar o UUID) conseguia ler os dados da marcação
alheia (`id`, `tipo`, `origem`, `registrado_em`, `dia_brt`,
`sinalizado_para_revisao`) enviando `senha_atual`, `foto_base64`,
`equipamento_id`, `nonce` e `assinatura` **completamente arbitrários** — só
precisava acertar o `tipo` (1 de 4 valores possíveis: `entrada`,
`saida_intervalo`, `retorno_intervalo`, `saida`).

**Por que passou despercebido:** os 19 testes de
`componente-equipamento.test.mjs` chamam
`equipamentoService.{emitirDesafio,registrarMarcacaoAssinada}`
**diretamente**, contornando deliberadamente a rota Express (documentado no
topo do próprio arquivo). Os testes de gate
(`componente-equipamento-gate-http.test.mjs`) exercitam a rota real, mas só
confirmam que ela retorna 501 — nunca chegam ao código que vive logo abaixo
do gate. Ou seja: nenhum teste existente jamais executou esse trecho
específico da rota com o gate aberto.

**Correção aplicada:** adicionado `.eq('usuario_id', req.user.id)` à
consulta de idempotência. Com o filtro, uma tentativa de reenvio de
`operacao_id` alheio simplesmente não encontra nada e cai no fluxo normal
de validação (senha → foto → assinatura), que rejeita corretamente.

**Prova:**
`scripts/tests/ponto/auditoria-adversarial-equipamento-http.test.mjs`,
teste "troca de usuário via idempotência: a vítima não vaza sua marcação
quando o atacante reenvia o operacao_id dela". Rodado **antes** da correção
contra o código real (gate aberto só neste processo de teste isolado via
`node:test`'s `mock.module`, nunca a constante real alterada em disco):
falhou, confirmando o vazamento (200 com os dados da vítima). Rodado
**depois** da correção: passa (401, sem nenhum campo da marcação da vítima
na resposta).

## Novos testes adversariais (via HTTP real, não via camada de serviço)

Arquivo novo: `scripts/tests/ponto/auditoria-adversarial-equipamento-http.test.mjs`.

Usa `node:test`'s `mock.module` (requer `--experimental-test-module-mocks`,
adicionado a `scripts/run-ponto-tests.mjs`) para sobrescrever
`EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` como `true` **só dentro do processo
isolado daquele arquivo de teste** (cada arquivo de
`scripts/tests/ponto/*.test.mjs` já roda como processo `node` separado —
ver `scripts/run-ponto-tests.mjs`). A constante real em
`src/lib/ponto/equipamento.js` nunca é alterada em disco — continua `false`
em todo lugar fora daquele processo (produção, todo o resto da suíte,
`git diff`). Isso permite exercitar pela primeira vez, via HTTP de ponta a
ponta, o código real que fica atrás do gate — nunca testado dessa forma
antes.

7 testes, todos contra a rota Express real:

1. Caminho feliz: desafio + assinatura + marcação via HTTP real.
2. **Troca de usuário via idempotência** (achado acima).
3. Idempotência legítima preservada (a correção não quebra retry do
   próprio usuário).
4. Replay: nonce já consumido reaproveitado com `operacao_id` novo → 409,
   via HTTP real.
5. Desafio expirado: assinatura genuína sobre um desafio emitido pela rota
   real, mas já expirado → 410, via HTTP real.
6. Chave revogada: equipamento revogado entre o desafio e a marcação →
   403, via HTTP real, mesmo com assinatura genuína.
7. Troca de equipamento: outro usuário não consegue pedir desafio para um
   equipamento que não é seu → 403, via HTTP real.

Suíte completa (14 arquivos, existente + este novo) rodada contra um
cluster Postgres **exclusivo** deste worktree (`127.0.0.1:55493`,
`meu_ponto_audit_test`, data dir em `.localdev/pgdata-audit` — nunca
`5432`/`5433`/`vivenzza_dev`): **0 falhas**.

## Revisado e confirmado sem defeito (não é lista de "não olhei")

- **Replay de nonce** (camada de serviço, `componente-equipamento.test.mjs`
  + novo teste via HTTP): nonce marcado como usado atomicamente
  (`UPDATE ... WHERE usado_em IS NULL`) dentro da mesma transação da
  função Postgres `ponto_registrar_marcacao_assinada` (migration 053);
  reaproveitar um nonce consumido é rejeitado (`desafio_ja_usado`) mesmo
  chamando a função direto, contornando a verificação de assinatura em
  Node.
- **Troca de usuário/equipamento**: `emitirDesafio` verifica
  `equipamento.usuario_id === usuarioId` antes de emitir; a função SQL
  revalida `v_equip.usuario_id <> p_usuario_id` de novo, fresco, dentro da
  transação (nunca confia só na pré-checagem em JS). Um nonce que exista
  mas pertença a outro equipamento/usuário é tratado como "não encontrado"
  — não vaza qual parte da combinação não bateu.
- **Conteúdo (hash da foto)**: `hash_conteudo` assinado é comparado contra
  o hash recalculado a partir da foto **realmente recebida**
  (`calcularHashConteudo(fotoBuffer)`), nunca confia num hash vindo do
  corpo da requisição; foto trocada depois do desafio é rejeitada
  (`conteudo_nao_confere`).
- **Desafio expirado**: checado dentro da mesma transação
  (`v_desafio.expira_em < now()`), com `FOR UPDATE` serializando tentativas
  concorrentes sobre o mesmo nonce.
- **Chave revogada**: `status <> 'ativo'` revalidado fresco dentro da
  função SQL — uma assinatura genuína sobre uma chave já revogada é
  rejeitada mesmo assim.
- **HMAC do desafio** (`verificarAssinaturaDesafio`,
  `assinaturaEquipamento.js`): comparação com `crypto.timingSafeEqual`,
  comprimento validado antes de comparar (evita lançar por tamanhos
  diferentes) — sem vulnerabilidade de timing óbvia.
- **Downgrade de chave hardware-backed**: `chave_hardware_backed` é
  tratado como **informativo, nunca uma prova remotamente atestada** — o
  próprio protocolo já documenta isso explicitamente (nenhuma alegação de
  atestação remota é feita em lugar nenhum do código ou dos docs). Não é um
  defeito técnico; é uma limitação de design já corretamente disclaimed.
  Observação (não é um defeito, não corrigida aqui): `completarVinculoEquipamento`
  não impede reemitir um vínculo para um equipamento já em `modo='producao'`
  — um admin pode re-registrar/trocar a chave de um equipamento já ativo
  sem um passo explícito de "isto é uma re-chave, não um cadastro
  original". Todo re-registro já gera um evento de auditoria
  (`chave_registrada`), mas esse evento não distingue os dois casos. Como
  só um admin (rota `adminOnly`) pode gerar o código de vínculo que
  viabiliza isso, não é uma escalada de privilégio — é só uma melhoria de
  auditoria possível para o futuro, fora do escopo desta auditoria.
- **Comprometimento local / serviço Windows** (`servico.mjs`): as 6 camadas
  de defesa descritas na proposta estão de fato implementadas — loopback
  only (`127.0.0.1`, nunca `0.0.0.0`), allowlist exata de `Origin`,
  allowlist exata de `Host` (defesa adicional contra DNS rebinding), token
  de pareamento local por processo, verificação do HMAC do backend sobre o
  desafio **antes** de considerar assinar (a defesa que não depende do
  navegador respeitar nada), e confirmação visível ao usuário antes da
  assinatura de fato. Requisição sem `Origin` é rejeitada (falha fechado).
  Não há rota genérica de "assine qualquer coisa" — só os dois endpoints de
  negócio, cada um com formato de payload fixo.

## Achado relacionado, fora de escopo (não corrigido nesta PR)

`POST /api/ponto/solicitacoes` (rota pré-existente, migration 049, não faz
parte do componente de equipamento) tem exatamente o mesmo padrão: a
checagem de idempotência (`src/routes/ponto.js`, handler de
`/solicitacoes`) também filtra só por `operacao_id`, sem
`usuario_id = req.user.id`. A exploração aqui é bem mais difícil — o
retorno antecipado só acontece se `tipo` **e** `justificativa` baterem
exatamente com o texto livre original (`existente.justificativa ===
justificativa.trim()`), não só o `tipo` — mas o padrão de risco é o mesmo.
Não corrigido aqui por estar fora do escopo desta auditoria (componente de
equipamento) e para manter esta PR pequena e focada num único domínio, por
instrução do projeto. Recomendação: mesmo tratamento (`.eq('usuario_id',
req.user.id)`) numa PR dedicada e pequena.

## Estado preservado (nada mudou aqui)

- `EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA` continua `false` em
  `src/lib/ponto/equipamento.js` — não tocado por esta auditoria.
- `ponto_config.piloto_ativo` continua `false` por padrão em toda
  migration/reset — só ligado deliberadamente pelos próprios testes, dentro
  do cluster isolado, nunca fora dele.
- Nenhuma migration aplicada em produção/staging, nenhum bucket real
  tocado, nenhuma instalação em máquina real, nenhum merge, nenhum deploy.
- Nenhum arquivo de Financeiro/Fiscal/WhatsApp/Voz/Scheduler tocado.

## Como reproduzir

```bash
# Cluster Postgres exclusivo (nunca 5432/5433/vivenzza_dev) — exemplo usado
# nesta auditoria, ajuste porta/dir conforme necessário:
LOCAL_PG_DATA=".localdev/pgdata-audit" LOCAL_PG_PORT=55493 \
  LOCAL_PG_DATABASE=meu_ponto_audit_test node scripts/localdb-start.mjs
LOCAL_PG_DATA=".localdev/pgdata-audit" LOCAL_PG_PORT=55493 \
  LOCAL_PG_DATABASE=meu_ponto_audit_test node scripts/localdb-reset.mjs

PONTO_TEST_PG_PORT=55493 PONTO_TEST_PG_DATABASE=meu_ponto_audit_test \
  npm run test:ponto
```
