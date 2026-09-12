# Verificação pendente — estornos_financeiros / fn_baixar_titulo e RPCs de estorno

Consultas **read-only**, prontas para a supervisão rodar direto no SQL
Editor do Supabase real (nenhuma delas altera nada). Objetivo: confirmar
que `supabase/migrations/20260101000057` a `20260101000062` (adicionadas
nesta tarefa, a partir do conteúdo já versionado em `migrations/*.sql`)
batem com o que está de fato live em produção, antes de aplicar essas
migrations lá. Mesmo procedimento que a PR #77 usou para
`fn_sincronizar_baixa_legado` (`pg_get_functiondef`/`pg_proc`,
`information_schema`, painel de Database → Roles/Policies).

Esta sessão **não tem acesso a produção** e não rodou nenhuma dessas
consultas — só está reportando o texto exato para a supervisão executar.

## 1. Corpo real das 4 functions (comparar com 20260101000058-000061)

```sql
SELECT p.proname, pg_get_functiondef(p.oid) AS definicao
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('fn_baixar_titulo', 'fn_estornar_baixa', 'fn_aprovar_estorno', 'fn_rejeitar_estorno')
ORDER BY p.proname;
```

## 2. Schema real de estornos_financeiros (comparar com 20260101000057)

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'estornos_financeiros'
ORDER BY ordinal_position;

SELECT conname, pg_get_constraintdef(oid) AS definicao
FROM pg_constraint
WHERE conrelid = 'public.estornos_financeiros'::regclass;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'estornos_financeiros';
```

## 3. Grants reais das 4 functions (comparar com 20260101000062)

```sql
SELECT p.proname,
       r.rolname AS grantee,
       has_function_privilege(r.rolname, p.oid, 'EXECUTE') AS tem_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN (VALUES ('public'), ('anon'), ('authenticated'), ('service_role'), ('postgres')) AS r(rolname)
WHERE n.nspname = 'public'
  AND p.proname IN ('fn_baixar_titulo', 'fn_estornar_baixa', 'fn_aprovar_estorno', 'fn_rejeitar_estorno')
ORDER BY p.proname, r.rolname;
```

## 4. Se `estornos_financeiros` já existir: contagem de linhas (achado anterior: "existe mas está vazia")

```sql
SELECT count(*) FROM public.estornos_financeiros;
```

## O que fazer com o resultado

- Se os 4 corpos (#1) e o schema da tabela (#2) baterem com
  `supabase/migrations/20260101000057-000061`: as migrations já estão
  prontas para aplicar em produção como estão (nenhuma mudança de código
  necessária).
- Se `#1`/`#2` divergirem: **não aplicar** as migrations como estão — reportar
  a divergência de volta a esta tarefa (ou abrir um follow-up) para corrigir
  o texto da migration a partir do que a consulta real devolveu, nunca o
  contrário.
- Se `#3` mostrar `anon`/`authenticated` com `tem_execute = true` hoje: confirma
  o achado de segurança descrito em `20260101000062` — aplicar essa migration
  em produção passa a ser prioritário, não só um endurecimento preventivo.
