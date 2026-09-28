# Incidente 2026-09-28 — Cloudflare 522 no Supabase, avalanche de GET /api/leads, webhooks expirados

## Sintoma reportado

Host do Supabase retornando **Cloudflare 522** (origem inalcançável) por um
período. Nas requisições que chegavam a completar, latências de **90-300s**.
Efeito em cascata: avalanche de `GET /api/leads` (backend), e webhooks da
Evolution API expirando (o processo Node ficava ocupado esperando chamadas
lentas/travadas ao Supabase e não respondia o webhook a tempo do prazo de
entrega do provider).

## Causa raiz — amplificação em cascata, não só a instabilidade em si

Uma instabilidade pontual do Supabase é inevitável e, sozinha, não deveria
derrubar o atendimento. O que transformou isso num incidente maior foi a
**ausência de proteção contra cascata** em três pontos:

1. **Nenhum timeout explícito** em várias chamadas críticas ao Supabase —
   uma chamada podia ficar pendurada pelo tempo que o Supabase levasse (até
   300s no pior caso observado), sem desistir.
2. **Nenhum circuit breaker** — mesmo timeout curto, cada requisição NOVA
   ainda pagava o timeout inteiro antes de desistir. Sob rajada (múltiplas
   abas do CRM abertas, retries, polling), isso empilhava dezenas de
   conexões concorrentes contra um backend que já estava afogado,
   piorando a degradação em vez de só sofrer com ela.
3. **Nenhuma coalescência/dedup** de leituras concorrentes idênticas — N
   abas pedindo exatamente a mesma coisa no mesmo instante geravam N
   consultas reais redundantes.

O frontend (`vivenzza-crm-frontend`) amplificou a rajada (ver seção
"Correção necessária no frontend" abaixo), mas a causa raiz de o backend
ter ficado indisponível por cascata — não só lento — é a ausência das três
proteções acima.

## Contenção aplicada nesta PR (backend, `vivenzza-crm-api`)

Escopo: `GET /api/leads` (a rota citada explicitamente no incidente) e o
caminho crítico de leitura do webhook do WhatsApp (`src/lib/distribuicao.js`,
`src/lib/clienteErpMatch.js`) — mesma causa raiz, mesmo padrão de correção.

- **`src/lib/circuitBreaker.js`** (novo) — circuit breaker genérico
  (fechado/aberto/meio-aberto, com backoff exponencial no cooldown). Depois
  de falhas consecutivas, abre e rejeita na hora, sem tocar o Supabase, até
  o cooldown passar; testa a recuperação sozinho (1 chamada de prova) e
  fecha de novo quando o Supabase volta a responder.
- **`src/lib/promiseTimeout.js`** (novo) — timeout via `Promise.race`
  manual, para os poucos lugares onde a chamada protegida não é
  necessariamente um builder encadeável do supabase-js (ex: RPC mockada em
  teste).
- **`src/routes/leads.js`** — `GET /` e `GET /:id` agora somam as três
  camadas: timeout fail-fast (`.abortSignal(AbortSignal.timeout(...))`),
  circuit breaker compartilhado com as rotas de escrita, e cache
  curto + single-flight (`src/lib/singleFlightCache.js`, mesmo mecanismo já
  usado em `GET /api/dashboard/atendimento` desde a PR #129) — requisições
  concorrentes pro mesmo escopo+filtros coalescem numa única execução real.
  Timeout também aplicado às rotas de escrita (POST/PUT/DELETE), para que
  uma mutação nunca fique pendurada além do limite configurado.
- **`src/lib/distribuicao.js`** (`proximoVendedor`, `criarOuObterLeadWhatsapp`
  — usadas pelo webhook do WhatsApp) — timeout por tentativa +
  circuit breaker envolvendo o loop de retry inteiro. Antes, uma
  degradação prolongada do Supabase fazia CADA webhook pagar até 3
  tentativas × timeout inteiro antes de desistir; agora, depois de falhas
  consecutivas, desiste na hora (mesmo fallback de sempre: lead sem
  distribuição automática, nunca perde a mensagem).
- **`src/lib/clienteErpMatch.js`** (`construirMapaTelefonesClientesErp`,
  chamada a cada evento de webhook que tenta casar o contato com o ERP) —
  timeout + teto de páginas + circuit breaker, mesmo padrão de
  `ATENDIMENTO_MAX_PAGINAS` (dashboard.js).

Configuração via env vars (todas com default sensato, nenhuma
obrigatória): `LEADS_QUERY_TIMEOUT_MS`, `LEADS_LIST_CACHE_TTL_MS`,
`LEADS_BREAKER_FALHAS_PARA_ABRIR`, `LEADS_BREAKER_COOLDOWN_MS`,
`LEADS_BREAKER_COOLDOWN_MAX_MS`, `DISTRIBUICAO_RPC_TIMEOUT_MS`,
`DISTRIBUICAO_BREAKER_*`, `CLIENTE_ERP_QUERY_TIMEOUT_MS`,
`CLIENTE_ERP_BREAKER_*`.

**Nada disso foi ativado com valores agressivos por padrão** — os defaults
(timeout 8s, 5 falhas consecutivas pra abrir, cooldown 15s com backoff até
2min) só mudam o comportamento sob degradação real do Supabase; em operação
normal, o caminho é idêntico ao anterior.

## Correção necessária no frontend (`vivenzza-crm-frontend`) — NÃO aplicada aqui

Fora de escopo desta PR (repositório separado). Documentado aqui pra quem
for aplicar a correção lá. Achados concretos (leitura do código, sem
alteração):

1. **`src/pages/Pipeline.jsx`, `refreshSilently`** (auto-refresh do board,
   a cada 30s) — busca **TODAS as páginas** de `/api/leads` em sequência a
   cada tick (`PAGE_SIZE=50`; com a base atual de leads isso já passa de 30
   requisições sequenciais por tick, por aba aberta). Cresce sem limite com
   o total de leads. Sugestão: paginar de verdade no board (buscar só o que
   está visível/precisa atualizar), ou pelo menos aumentar drasticamente o
   `PAGE_SIZE` e/ou espaçar o intervalo.
2. **`src/hooks/useLeadPolling.js`** — outro polling independente (`GET
   /api/leads?desde=...&limit=10`) a cada 30s, por aba, somando-se ao acima.
3. **`src/lib/api.js`** — o client axios (`api = axios.create({baseURL:
   ...})`) **não tem `timeout` configurado**. Sob um backend lento/travado,
   o browser mantém a conexão aberta indefinidamente — sem timeout do lado
   do cliente, não há como o frontend desistir e tentar de novo com
   backoff; ele só demonstra o problema (spinner infinito), não contribui
   pra resolvê-lo. Sugestão: definir um timeout razoável (ex: 15-20s) no
   client axios.
4. **Nenhum backoff entre falhas consecutivas** nos dois mecanismos de
   polling acima — se uma chamada falha (ou expira via item 3), a próxima
   tentativa acontece no mesmo intervalo fixo de 30s, sem espaçar. Com N
   abas em lockstep (mesmo intervalo, sem jitter), todas elas continuam
   batendo simultaneamente num backend já degradado. Sugestão: backoff
   exponencial após falhas consecutivas + jitter aleatório no intervalo
   base, pra dessincronizar abas diferentes.

Nenhuma dessas mudanças foi implementada — isso pertence ao repositório
`vivenzza-crm-frontend`, fora do escopo desta PR.

## O que NÃO foi tocado

- Nenhum deploy, nenhuma migration aplicada em produção, nenhum envio real.
- Nenhuma mudança de comportamento fora do caminho de leitura/escrita de
  `leads` e do caminho crítico do webhook do WhatsApp citados acima.
- `scripts/localdb/schema-baseline/012_leads_cliente_erp_fk_test_only.sql`
  (novo) é **só ambiente sintético local de teste** — adiciona a constraint
  de FK nomeada que faltava no baseline local pra o embed
  `clientes_erp!leads_cliente_erp_id_fkey` (já usado pela rota há muito
  tempo) funcionar contra o Postgres local de teste. Nunca aplicado em
  produção.
