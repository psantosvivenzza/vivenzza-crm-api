-- Tabela de CFOPs (Código Fiscal de Operações e Prestações) — cadastro usado no
-- autocomplete de série 1 (NF-e SEFAZ) e série 99 (Nota Interna). Ambas as séries
-- têm acesso ao cadastro completo, sem restrição por tipo de documento.
-- Execute no Supabase SQL Editor (já aplicado via MCP em 2026-07-27).
--
-- Lista curada dos CFOPs mais comuns de venda/transferência (dentro e fora do
-- estado) pro segmento de cosméticos/varejo da Vivenzza — não é a tabela CFOP
-- completa da SEFAZ (centenas de códigos), só o subconjunto relevante pro dia a dia.

CREATE TABLE public.cfops (
  codigo varchar(10) PRIMARY KEY,
  descricao text NOT NULL
);

INSERT INTO public.cfops (codigo, descricao) VALUES
('5101', 'Venda de produção do estabelecimento'),
('5102', 'Venda de mercadoria adquirida ou recebida de terceiros'),
('5103', 'Venda de produção do estabelecimento, efetuada fora do estabelecimento'),
('5104', 'Venda de mercadoria adquirida ou recebida de terceiros, efetuada fora do estabelecimento'),
('5109', 'Venda de produção do estabelecimento destinada à Zona Franca de Manaus ou Áreas de Livre Comércio'),
('5110', 'Venda de mercadoria adquirida ou recebida de terceiros destinada à Zona Franca de Manaus ou ALC'),
('5116', 'Venda de produção do estabelecimento originada de encomenda para entrega futura'),
('5117', 'Venda de mercadoria adquirida ou recebida de terceiros originada de encomenda para entrega futura'),
('5151', 'Transferência de produção do estabelecimento'),
('5152', 'Transferência de mercadoria adquirida ou recebida de terceiros'),
('5401', 'Venda de produção do estabelecimento em operação com produto sujeito ao regime de substituição tributária, na condição de contribuinte substituto'),
('5403', 'Venda de mercadoria adquirida ou recebida de terceiros sujeita ao regime de substituição tributária, na condição de contribuinte substituto'),
('5405', 'Venda de mercadoria adquirida ou recebida de terceiros sujeita ao regime de substituição tributária na condição de substituído tributário'),
('5910', 'Remessa em bonificação, doação ou brinde'),
('5911', 'Remessa de amostra grátis'),
('5912', 'Remessa de mercadoria ou bem para demonstração'),
('5913', 'Retorno de mercadoria ou bem recebido para demonstração'),
('5914', 'Remessa de mercadoria ou bem para exposição ou feira'),
('5915', 'Remessa de mercadoria ou bem para conserto ou reparo'),
('5916', 'Retorno de mercadoria ou bem recebido para conserto ou reparo'),
('5920', 'Remessa de vasilhame ou sacaria'),
('5921', 'Retorno de vasilhame ou sacaria'),
('5949', 'Outra saída de mercadoria ou prestação de serviço não especificado'),
('6101', 'Venda de produção do estabelecimento (operação interestadual)'),
('6102', 'Venda de mercadoria adquirida ou recebida de terceiros (operação interestadual)'),
('6108', 'Venda de mercadoria adquirida ou recebida de terceiros, destinada a não contribuinte'),
('6109', 'Venda de produção do estabelecimento destinada a não contribuinte'),
('6117', 'Venda de mercadoria adquirida ou recebida de terceiros originada de encomenda para entrega futura (interestadual)'),
('6151', 'Transferência de produção do estabelecimento (interestadual)'),
('6152', 'Transferência de mercadoria adquirida ou recebida de terceiros (interestadual)'),
('6401', 'Venda de produção do estabelecimento em operação com produto sujeito ao regime de substituição tributária (interestadual)'),
('6403', 'Venda de mercadoria adquirida ou recebida de terceiros sujeita ao regime de substituição tributária, na condição de contribuinte substituto (interestadual)'),
('6404', 'Venda de mercadoria sujeita ao regime de substituição tributária, cujo imposto já tenha sido retido (interestadual)'),
('6910', 'Remessa em bonificação, doação ou brinde (interestadual)'),
('6911', 'Remessa de amostra grátis (interestadual)'),
('6949', 'Outra saída de mercadoria ou prestação de serviço não especificado (interestadual)');
