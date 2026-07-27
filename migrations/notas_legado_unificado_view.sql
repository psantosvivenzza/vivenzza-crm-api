-- Histórico NF unificado: combina duas fontes de dados legadas distintas.
-- Execute no Supabase SQL Editor (já aplicado via MCP em 2026-07-27).
--
-- CONTEXTO (investigação desta sessão):
-- - vendas_legado: migração validada (20/20 amostragem) das NFs modelo 01/série 99
--   ("notas internas" do NetVision) — 6.848 registros, todos com cliente_erp_id
--   real vinculado.
-- - nfe.serie=1: as NF-e SEFAZ reais do NetVision (série "E" no legado — o campo
--   numérico `serie` virou 1 na conversão; legacy_id confirma o sufixo "-E", ex.
--   '001-56-E'). De 3.534 notas nessa série, 3.093 têm dest_nome válido — as
--   demais 441 (e TODAS as séries 0,2,3,5,10,33,55,890) têm dest_nome genérico
--   ('L&L SANTOS COSMETICOS LTDA', a própria Vivenzza) — artefato de importação
--   sem cliente real identificável, por isso ficam de fora da view.
--
-- A view expõe as duas fontes já normalizadas pro mesmo formato (id, origem,
-- numero, serie, serie_label, data_emissao, valor_total, status, em_revisao,
-- cliente_nome, cliente_cnpj), permitindo paginação/ordenação/filtro únicos
-- em GET /api/admin/erp/notas-legado sem duplicar lógica de merge no backend.

CREATE VIEW public.notas_legado_unificado AS
SELECT
  v.id,
  'vendas_legado'::text AS origem,
  v.numero_nf AS numero,
  '99'::text AS serie,
  'Interna'::text AS serie_label,
  v.data_emissao,
  v.valor_total,
  v.status,
  v.em_revisao,
  COALESCE(c.razao_social, 'Cliente não identificado') AS cliente_nome,
  c.cnpj_cpf AS cliente_cnpj
FROM public.vendas_legado v
LEFT JOIN public.clientes_erp c ON c.id = v.cliente_erp_id

UNION ALL

SELECT
  n.id,
  'nfe'::text AS origem,
  n.numero::text AS numero,
  'E'::text AS serie,
  'NF-e SEFAZ'::text AS serie_label,
  n.data_emissao::date AS data_emissao,
  n.valor_total,
  n.status,
  false AS em_revisao,
  n.dest_nome AS cliente_nome,
  n.dest_cnpj_cpf AS cliente_cnpj
FROM public.nfe n
WHERE n.serie = 1
  AND n.dest_nome IS NOT NULL
  AND n.dest_nome NOT ILIKE '%L&L SANTOS%'
  AND n.dest_nome NOT ILIKE '%COSMETICOS LTDA%';
