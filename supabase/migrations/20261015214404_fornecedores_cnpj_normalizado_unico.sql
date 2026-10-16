-- Versao retornada pelo journal de producao ao aplicar via conector Vivenzza.
-- CLI Supabase indisponivel localmente; SQL revisado antes da aplicacao.
-- Nao remove nem modifica fornecedores existentes; aborta se houver duplicatas.
CREATE UNIQUE INDEX IF NOT EXISTS fornecedores_cnpj_normalizado_uidx
ON public.fornecedores ((regexp_replace(upper(cnpj), '[^0-9A-Z]', '', 'g')));
