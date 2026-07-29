-- Adiciona cliente_legacy_id (código do cliente, clientes_erp.legacy_id) à view
-- notas_legado_unificado — código-do-cliente-em-toda-parte (ver contexto no
-- commit "Implementar código do cliente como identificador universal").
--
-- Só a origem 'vendas_legado' tem código real (via clientes_erp.legacy_id,
-- FK já existente em vendas_legado.cliente_erp_id). A origem 'nfe' (série E)
-- não tem NENHUMA FK pra clientes_erp — o destinatário é só texto livre
-- (dest_nome/dest_cnpj_cpf) — então cliente_legacy_id fica NULL ali; não dá
-- pra resolver isso sem uma mudança de schema maior (adicionar cliente_erp_id
-- em nfe), fora de escopo aqui.
--
-- Execute este script no Supabase SQL Editor.

CREATE OR REPLACE VIEW public.notas_legado_unificado AS
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
  c.cnpj_cpf AS cliente_cnpj,
  c.legacy_id AS cliente_legacy_id
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
  n.dest_cnpj_cpf AS cliente_cnpj,
  NULL::text AS cliente_legacy_id
FROM public.nfe n
WHERE n.serie = 1
  AND n.dest_nome IS NOT NULL
  AND n.dest_nome NOT ILIKE '%L&L SANTOS%'
  AND n.dest_nome NOT ILIKE '%COSMETICOS LTDA%';
