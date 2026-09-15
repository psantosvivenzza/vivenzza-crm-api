-- CORREÇÃO URGENTE (2026-09-09): tentativa de criar o primeiro usuário
-- role='financeiro' em produção falhou com:
--   "new row for relation "usuarios" violates check constraint
--   "usuarios_role_check""
-- mesmo a aplicação (middleware/routes/usuarios.js PAPEIS_VALIDOS) já
-- aceitando 'financeiro' desde a PR #75. Causa: usuarios_role_check
-- NUNCA esteve em nenhuma migration versionada nem no baseline local — só
-- existia em produção. Confirmado por leitura direta do catálogo real
-- (pg_constraint, via SQL Editor do Supabase, 2026-09-09):
--
--   usuarios_role_check:
--   CHECK ((role = ANY (ARRAY['admin'::text, 'vendedor'::text])))
--
-- Mesmo padrão de drift de schema já visto nesta base (sdr_conversas,
-- leads.atendimento_humano, nfe/nfe_itens, fn_baixar_titulo e afins) —
-- reproduzido fielmente no baseline local em
-- scripts/localdb/schema-baseline/001_core.sql (ver commit desta mesma
-- correção) exatamente com este texto, ANTES desta migration rodar, pra
-- que o teste local reproduza a falha de verdade.
--
-- Troca a constraint por uma que aceita 'admin' e 'vendedor' (preservados,
-- nenhuma linha de usuarios é tocada — só a definição da constraint muda)
-- mais 'financeiro' (novo). Qualquer outro valor continua rejeitado — a
-- proteção nunca fica ausente, nem temporariamente: DROP+ADD dentro da
-- mesma transação, sob ACCESS EXCLUSIVE lock (padrão de ALTER TABLE), então
-- nenhuma outra sessão consegue inserir uma linha entre o DROP e o ADD.
--
-- lock_timeout/statement_timeout como SET LOCAL (efeito só dentro desta
-- transação, revertem sozinhos no fim) — evita ficar esperando
-- indefinidamente um lock em produção se outra sessão estiver seg-
-- urando `usuarios` no momento da aplicação; se não conseguir o lock em
-- 5s, falha com erro claro (ver procedimento de aplicação no PR) em vez
-- de bloquear outras queries em `usuarios` por tempo indeterminado.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '10s';

ALTER TABLE public.usuarios
  DROP CONSTRAINT IF EXISTS usuarios_role_check;

ALTER TABLE public.usuarios
  ADD CONSTRAINT usuarios_role_check
  CHECK (role = ANY (ARRAY['admin'::text, 'vendedor'::text, 'financeiro'::text]));

COMMIT;
