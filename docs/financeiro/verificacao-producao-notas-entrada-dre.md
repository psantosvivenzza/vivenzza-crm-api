# Verificação pendente — notas_entrada / estoque / fn_criar_nota_entrada

Consultas **read-only**, prontas para a supervisão rodar direto no SQL
Editor do Supabase real (nenhuma delas altera nada). Objetivo: confirmar que
`supabase/migrations/20260101000064` a `000066` (adicionadas nesta tarefa)
batem com o que está de fato live em produção, antes de aplicar essas
migrations lá. Mesmo procedimento usado pelas PRs #77/#79
(`pg_get_functiondef`/`pg_proc`, `information_schema`, painel de
Database → Roles/Policies) — ver
`docs/claude-context/verificacao-producao-estornos-baixar-titulo.md` para o
precedente.

Esta sessão **não tem acesso a produção** e não rodou nenhuma dessas
consultas — só está reportando o texto exato para a supervisão executar. O
schema abaixo já foi CONFIRMADO contra produção real via SQL Editor em 3
rodadas anteriores desta tarefa (ver
`docs/financeiro/schema-real-producao-dre-notas-entrada.md`); estas consultas
são a verificação FINAL, formal, antes de aplicar as migrations.

## 1. Corpo real de fn_criar_nota_entrada / atualizar_saldo_estoque

```sql
SELECT p.proname, pg_get_functiondef(p.oid) AS definicao
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('fn_criar_nota_entrada', 'atualizar_saldo_estoque')
ORDER BY p.proname;
```

Comparar com o corpo em `supabase/migrations/20260101000065_notas_entrada.sql`
(fn_criar_nota_entrada) e `20260101000064_estoque_movimentacoes.sql`
(atualizar_saldo_estoque — atenção especial ao `SET search_path`, ver achado
de drift no comentário de topo desse arquivo).

## 2. Schema real de notas_entrada / notas_entrada_itens / estoque / movimentacoes_estoque

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('notas_entrada', 'notas_entrada_itens', 'estoque', 'movimentacoes_estoque')
ORDER BY table_name, ordinal_position;

SELECT conrelid::regclass AS tabela, conname, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conrelid::regclass::text IN ('public.notas_entrada', 'public.notas_entrada_itens', 'public.estoque', 'public.movimentacoes_estoque');

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('notas_entrada', 'notas_entrada_itens', 'estoque', 'movimentacoes_estoque');
```

## 3. Trigger trg_atualizar_saldo

```sql
SELECT tgname, tgenabled, pg_get_triggerdef(oid) AS definicao
FROM pg_trigger
WHERE tgrelid = 'public.movimentacoes_estoque'::regclass AND NOT tgisinternal;
```

## 4. Grants reais de fn_criar_nota_entrada (comparar com 20260101000066)

```sql
SELECT p.proname,
       r.rolname AS grantee,
       has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS tem_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN (VALUES ('public'), ('anon'), ('authenticated'), ('service_role'), ('postgres')) AS r(rolname)
WHERE n.nspname = 'public'
  AND p.proname = 'fn_criar_nota_entrada'
ORDER BY r.rolname;
```

## 5. produtos / nfe / nfe_itens — só leitura, confirmar schema já documentado

Estas 3 tabelas **não** têm migration nova nesta tarefa (pré-existentes, sem
histórico de versionamento neste repositório — mesma situação de
`usuarios`/`contas_financeiras`). Consulta abaixo é só para reconfirmar que
nada mudou em produção desde a última auditoria (rodada 3,
`docs/financeiro/schema-real-producao-dre-notas-entrada.md`):

```sql
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('produtos', 'nfe', 'nfe_itens')
ORDER BY table_name, ordinal_position;
```

## O que fazer com o resultado

- Se `#1` e `#2` baterem com `supabase/migrations/20260101000064-000065`: as
  migrations já estão prontas para aplicar em produção como estão (nenhuma
  mudança de código necessária).
- Se `#1`/`#2` divergirem: **não aplicar** as migrations como estão —
  reportar a divergência de volta a esta tarefa (ou abrir um follow-up) para
  corrigir o texto da migration a partir do que a consulta real devolveu,
  nunca o contrário.
- Se `#4` mostrar `anon`/`authenticated` com `tem_execute = true` hoje:
  confirma o achado de segurança descrito em `20260101000066` — aplicar essa
  migration em produção passa a ser prioritário, não só um endurecimento
  preventivo.
- Se `#5` divergir do schema documentado: **não aplicar** `000064`/`000065`
  em produção antes de reconciliar — ambas dependem de `produtos` (FK) e o
  DRE depende de `nfe`/`nfe_itens` continuarem no formato documentado.
