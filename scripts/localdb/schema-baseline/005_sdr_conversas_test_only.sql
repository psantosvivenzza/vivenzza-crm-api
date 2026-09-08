-- 2026-09-08 — sdr_conversas NÃO existe em nenhum SQL versionado do
-- repositório (nem migrations/ legado, nem supabase/migrations/) — mesma
-- categoria de gap já documentada para notas_entrada/whatsapp_mensagens/leads
-- em rodadas anteriores. Reconstruído aqui SOMENTE para o baseline de teste
-- local, via introspecção read-only do schema real de produção (OpenAPI do
-- PostgREST: required=[id,telefone,status_atendimento], defaults e tipos
-- confirmados coluna a coluna). `telefone` precisa de UNIQUE porque
-- src/routes/sdr.js usa `.upsert({...}, { onConflict: 'telefone' })`.
-- Nunca aplicado em produção — só ambiente sintético local exclusivo.
--
-- Necessário mesmo nesta versão reduzida: qualquer exercício do fluxo real
-- de processarLara() (por webhook, ponta a ponta) passa por esta tabela —
-- não é uma extensão do escopo excluído (decisões de config/handoff/
-- anti-loop, comportamento pós-falha ao salvar), só a tabela existir pra o
-- caminho normal funcionar.
CREATE TABLE IF NOT EXISTS public.sdr_conversas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telefone character varying NOT NULL UNIQUE,
  estado character varying DEFAULT 'novo',
  tipo_lead character varying DEFAULT 'indefinido',
  historico jsonb,
  nome_cliente character varying,
  ultimo_contato timestamp without time zone DEFAULT now(),
  criado_em timestamp without time zone DEFAULT now(),
  temperatura character varying DEFAULT 'frio',
  etapa_cadencia integer DEFAULT 1,
  status_atendimento character varying NOT NULL DEFAULT 'ia_atendendo'
);
