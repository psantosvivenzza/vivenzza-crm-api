# Hard cap de spend diário — Meta Ads Vivenzza

Teto de negócio: **R$150/dia**. Alerta em **R$130**, proteção (pausa reversível) em **R$145**.

Autorizado pelo usuário em 2026-08-11. Implementado desligado por padrão — precisa de ativação explícita (ver "Como ativar" abaixo).

## Arquitetura existente reaproveitada

Nada de infraestrutura nova. Tudo reaproveita o que já existe em `vivenzza-crm-api`:

- **Cron**: `node-cron` já configurado em `src/index.js` (mesmo padrão dos outros `cron.schedule(...)`, ex. `collection-payment-guard`).
- **Credenciais Meta**: `META_ACCESS_TOKEN`/`META_AD_ACCOUNT_ID`/`META_GRAPH_VERSION` já estão no ambiente de produção (Railway) — são as mesmas usadas por `src/jobs/meta-report.js`. Nenhum segredo novo.
- **WhatsApp**: mesmas env vars (`EVOLUTION_API_URL`/`EVOLUTION_API_KEY`/`EVOLUTION_INSTANCE`/`WHATSAPP_REPORT_NUMBER`) e mesmo destino do relatório diário. Lógica de envio extraída para `src/lib/whatsappAlert.js` (antes só existia inline em `meta-report.js`).
- **Kill-switch**: mesma tabela singleton `automacoes_config` (id=1) e mesmo padrão de `src/lib/collection/featureFlags.js` — automação nova que mexe com dinheiro real começa **desligada** (`meta_budget_guard_enabled=false`, `meta_budget_guard_dry_run=true`).
- **Idempotência**: mesmo padrão de `src/lib/collection/idempotency.js` (`integration_events`) — índice único no Postgres, não lógica em memória.
- **Estilo de teste**: mesmo padrão de `scripts/teste-collection-motor-puro.mjs` — checks simples sem framework, testando funções puras + a orquestração inteira com dependências injetadas (nenhuma chamada de rede/banco real no teste).

## Arquivos novos/alterados

| Arquivo | O que é |
|---|---|
| `migrations/meta_budget_guard.sql` + `supabase/migrations/20260101000025_meta_budget_guard.sql` | Colunas novas em `automacoes_config` (flags) + tabela `meta_budget_guard_log` |
| `src/lib/metaBudgetGuard.js` | Motor de decisão **puro** (sem I/O): `decidirNivel`, `diaContaBrt`, `pausasPendentesDeReativacao` |
| `src/lib/metaAdsGuardClient.js` | Wrapper fino da Graph API (ler spend, listar ativas, pausar/reativar, timezone da conta) |
| `src/lib/metaBudgetGuardConfig.js` | Leitura cacheada (5s) das flags em `automacoes_config` |
| `src/lib/whatsappAlert.js` | Envio de WhatsApp via Evolution (extraído do padrão já usado em `meta-report.js`) |
| `src/jobs/meta-budget-guard.js` | Orquestração: reset do dia anterior → lê spend de hoje → decide → age (idempotente, fail-safe) |
| `src/index.js` | +1 import, +1 `cron.schedule('*/5 * * * *', ...)` |
| `scripts/teste-meta-budget-guard.mjs` | 34 checks — funções puras + DRY RUN completo dos 6 cenários pedidos + falha de escrita + reset |
| `package.json` | +1 script `test:meta-budget-guard` |

Nenhum arquivo de campanha/criativo/público foi tocado.

## O que o job faz, a cada execução

1. **Reset**: busca no `meta_budget_guard_log` pausas (`action='paused'`) de dias anteriores ao dia corrente (no timezone da conta) que ainda não têm uma linha `resumed` correspondente (via `pause_action_id`). Reativa cada uma. Nunca toca em nada que não esteja no próprio log — logo nunca reativa algo pausado manualmente.
2. **Leitura de spend**: `GET /act_.../insights?level=account&date_preset=today` (o `date_preset=today` é resolvido pelo Meta no timezone da própria conta — confirmado `America/Sao_Paulo`). Se a chamada falhar: **para aqui, zero mudança de campanha**, só loga o erro.
3. **Decisão** (`decidirNivel`, pura): `spend < 130` → nada. `130 ≤ spend < 145` → ALERTA. `spend ≥ 145` → PROTEÇÃO.
4. **ALERTA**: manda 1 WhatsApp (idempotente — índice único trava duplicata no mesmo dia mesmo se o cron rodar várias vezes ou reiniciar no meio).
5. **PROTEÇÃO**: lista campanhas `ACTIVE` agora e pausa cada uma que ainda não foi pausada hoje (idempotente por campanha/dia). Nunca deleta nada. Grava `status_before_guard` (sempre `ACTIVE`, porque só pausa o que está ativo). Se pausar falhar na API: grava `write_failed` e manda alerta 🔴 — não trava o loop, tenta as outras campanhas.

## Frequência do cron e atraso máximo estimado

**`*/5 * * * *`** (a cada 5 minutos) — mesma ordem de grandeza dos outros guards do projeto (`collection-payment-guard` roda a cada 10 min).

Atraso estimado até uma ação de proteção acontecer, no pior caso:
- até 5 min de espera pelo próximo tick do cron, **+**
- o atraso da própria API de Insights do Meta em refletir spend real (não documentado com precisão pela Meta — na prática costuma ficar entre poucos minutos e ~20-30 min, podendo variar).

**Risco residual que não dá para eliminar só com esse desenho**: o buffer entre proteção (R$145) e teto (R$150) é de só R$5. No incidente de 10/08 que motivou isso, o Meta chegou a entregar ~40% acima do budget configurado num único dia — se um burst parecido acontecer bem no meio de uma janela de atraso da Insights API, o guard pode reagir tarde e o gasto passar visivelmente de R$150 antes de pausar. O guard reduz bastante a chance e o tamanho do estouro (comparado a nenhum controle, que foi o caso em 10/08), mas não é uma garantia matemática de nunca ultrapassar R$150 — isso só um limite de gasto configurado direto na conta Meta (`spend_cap` a nível de conta) garantiria de verdade, e essa é uma mudança de configuração da própria conta, fora do escopo desta automação.

## Testes

```
cd vivenzza-crm-api
npm run test:meta-budget-guard
```

34 checks, todos sem tocar rede/banco real (dependências injetadas). Cobre exatamente os 6 cenários pedidos (129/130/144/145/155/falha de leitura), mais falha de escrita na Meta e o reset do dia seguinte. Resultado atual: **34/34 passando**.

## Rollback

Em qualquer momento, para desligar tudo instantaneamente (sem deploy):

```sql
UPDATE automacoes_config SET meta_budget_guard_enabled = false WHERE id = 1;
```

O próximo tick do cron simplesmente pula (`{ pulado: true }`), sem tocar em nada. Se preferir reverter o código: `git revert` do commit, ou apagar o `cron.schedule` em `src/index.js` — como o guard só age quando `meta_budget_guard_enabled=true` no banco, remover só o cron/código já é seguro mesmo sem tocar a flag.

Para desfazer a migration (raro precisar, as colunas/tabela novas não afetam nada existente):

```sql
DROP TABLE IF EXISTS public.meta_budget_guard_log;
ALTER TABLE public.automacoes_config
  DROP COLUMN IF EXISTS meta_budget_guard_enabled,
  DROP COLUMN IF EXISTS meta_budget_guard_dry_run,
  DROP COLUMN IF EXISTS meta_budget_guard_alert_threshold,
  DROP COLUMN IF EXISTS meta_budget_guard_protect_threshold,
  DROP COLUMN IF EXISTS meta_budget_guard_hard_cap;
```

## Como ativar (nenhum passo abaixo foi executado)

Estado atual em produção depois deste trabalho: **migration ainda não aplicada, flags portanto inexistentes/default, cron já rodando mas sempre pulando** (porque a coluna não existe ainda até a migration rodar — na prática, antes da migration, `obterConfigMetaGuard` cai nos `DEFAULTS` do módulo, que já são `enabled=false`).

1. Rodar `migrations/meta_budget_guard.sql` no Supabase SQL Editor (produção).
2. Deploy do `vivenzza-crm-api` com esses arquivos.
3. Validar em produção com `meta_budget_guard_enabled=true` e `meta_budget_guard_dry_run=true` por pelo menos 1 dia — conferir no `meta_budget_guard_log` que as decisões (`alerted`/`paused` com `[DRY RUN]` na razão) fazem sentido contra o spend real do dia, sem nenhum efeito na conta.
4. Só depois, `UPDATE automacoes_config SET meta_budget_guard_dry_run = false WHERE id = 1;` para ativar de verdade.

Nenhum desses 4 passos foi executado nesta tarefa — combinado era deixar pronto para ativação real, não ativar.
