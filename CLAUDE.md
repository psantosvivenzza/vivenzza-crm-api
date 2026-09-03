# Vivenzza CRM — contexto operacional

CRM da Vivenzza Professional. Backend Node/Express + Supabase/Postgres
(`vivenzza-crm-api`, deploy no Railway). Frontend React/Vite
(`vivenzza-crm-frontend`, deploy no Vercel). NetVision (banco `e01`,
PostgreSQL) é a fonte de verdade para os domínios legados — financeiro,
fiscal, vendas, cadastro de clientes.

**Antes de mudar comportamento de cobrança, fiscal, WhatsApp ou voz, leia
[`docs/claude-context/README.md`](docs/claude-context/README.md).** Ele
indexa a documentação detalhada por domínio.

## Regras que nunca devem ser quebradas sem autorização explícita

- Nunca assumir que Série 99 é documento fiscal SEFAZ — ela é venda
  **gerencial** real, não fiscal (ver `docs/claude-context/fiscal-e-vendas.md`).
- Nunca misturar WhatsApp comercial e financeiro — são instâncias, pools e
  fluxos deliberadamente separados.
- Nunca emitir NF-e real sem autorização explícita — `serie1_numeracao_liberada`
  continua `false` até decisão em contrário.
- Nunca ativar `voice_external_enabled` automaticamente — chamada externa
  real exige autorização específica, sempre.
- Nunca ativar `whatsapp_failover` automaticamente — troca de instância só
  acontece para falha técnica inequívoca, e mesmo assim a flag em produção
  é uma decisão deliberada, não um padrão a reativar por conta própria.
- Nunca alterar limites globais de envio (`global_daily_limit`,
  `global_hourly_limit`) sem autorização explícita.
- Preservar sempre: idempotência de dispatch, DNC/opt-out, guard de
  pagamento, guard de promessa ativa, rate limit global e por instância.
- Preferir PR pequena e separada por domínio — não misturar correções de
  áreas diferentes (ex.: cobrança + fiscal) na mesma PR.
- Não inventar migration, flag ou tabela que não existe no código real —
  confirmar no `origin/main` atual antes de assumir que algo existe.
- Antes de concluir qualquer auditoria ou tarefa de "estado atual", validar
  contra o `origin/main` atual (`git fetch`), não contra memória de uma
  sessão anterior nem contra um checkout local desatualizado.

## Contexto histórico / handoff

Para contexto operacional e decisões acumuladas até 2026-09-03, consultar:

`docs/CHATGPT_HANDOFF_2026-09-03.md`

Importante: o código atual em `origin/main` e o estado real de produção
sempre prevalecem sobre o handoff.

## Onde as coisas ficam

- `docs/claude-context/` — este índice de contexto (arquitetura, decisões,
  pendências, histórico de PRs).
- `docs/cobranca-ai/` — documentação operacional mais granular do motor de
  cobrança (quando existir/for versionada).
- `supabase/migrations/` — migrations reais aplicadas em produção.
- `scripts/tests/collection/` — suíte de testes do motor de cobrança
  (`npm run test:collection`).
