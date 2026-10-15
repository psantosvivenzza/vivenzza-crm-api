-- Protege importação e cadastros concorrentes contra CNPJ com/sem máscara.
-- Não remove nem modifica fornecedores existentes; aborta se houver duplicatas.
CREATE UNIQUE INDEX IF NOT EXISTS fornecedores_cnpj_normalizado_uidx
ON public.fornecedores ((regexp_replace(upper(cnpj), '[^0-9A-Z]', '', 'g')));
