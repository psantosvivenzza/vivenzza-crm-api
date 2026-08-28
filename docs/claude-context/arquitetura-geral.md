# Arquitetura geral

## Backend — `vivenzza-crm-api`

- Node/Express.
- Banco: Supabase (Postgres gerenciado) — client administrativo em
  `src/lib/supabase-admin.server.js` (ignora RLS, só usado server-side).
- Deploy: Railway, disparado automaticamente por push em `main`.
- Rotas montadas em `src/index.js`, sempre atrás de `auth` (+ `adminOnly`
  para rotas administrativas — não existe papel "financeiro" separado no
  projeto, só `admin`/`vendedor`).

## Frontend — `vivenzza-crm-frontend`

- React + Vite, React Router.
- Deploy: Vercel, via GitHub Actions (`.github/workflows/deploy.yml`),
  disparado por push em `master` — usa `VERCEL_TOKEN`/`VERCEL_ORG_ID`/
  `VERCEL_PROJECT_ID` como GitHub Secrets, nunca hardcoded.
- Client de API único: `src/lib/api.js` (axios, injeta o token de sessão).
- Design system "Dark Luxury" — páginas novas devem usar os primitivos de
  `src/components/ui/` (Table, Badge, MetricCardPro, PageHeader,
  EmptyState) e entrar na allowlist `ROTAS_MIGRADAS` em `Layout.jsx`.

## Legado — NetVision

- ERP legado da empresa, banco PostgreSQL próprio (`e01`), só acessível da
  rede local do escritório (VPN Radmin no ambiente atual quando a máquina
  não está fisicamente na rede).
- Fonte de verdade para: financeiro (títulos, baixas), fiscal (notas
  fiscais reais), vendas por representante, cadastro de clientes.
- Como o `e01` não é alcançável do Railway, os syncs (`sync-financeiro-legado`,
  `sync-vendas-fiscais-legado`, `sync-vendas-gerenciais-legado`) rodam
  **residentes** na máquina do escritório via Task Scheduler, escrevendo
  read-models no Supabase. A API na nuvem só **lê** o resultado — nunca
  conecta direto no `e01`.

## Separação clara de domínios

| Domínio | Onde fica | Read-model / fonte |
|---|---|---|
| Financeiro (contas a receber) | `contas_financeiras` | sync financeiro ← NetVision `CR_Duplicatas` |
| Vendas gerenciais | `vendas_gerenciais_netvision` | sync vendas gerenciais ← NetVision `EN_NotasRepres` |
| Fiscal (NF-e real) | `notas_fiscais_netvision` | sync fiscal ← NetVision `EN_Notas` |
| Pedidos | `pedidos` | CRM próprio, não é venda automaticamente |
| WhatsApp (cobrança) | `whatsapp_instances`, `collection_*` | motor de cobrança v2 |
| Voz/IA | `src/lib/voice/`, `src/lib/collection/telephony/` | Asterisk local (lab) |

Cada domínio tem seu próprio sync/read-model — nunca reaproveitar a fonte
de um domínio para responder pergunta de outro (ex.: nunca usar
`ES_Pedidos` para "Vendas do Mês" — ver
[`fiscal-e-vendas.md`](fiscal-e-vendas.md)).
