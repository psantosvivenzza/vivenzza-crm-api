-- Colunas de suporte a: hash de integridade dos XMLs, registro do ambiente em
-- que a nota foi de fato processada (não confundir com a config global de
-- ambiente — isso aqui é o que estava valendo no momento desta nota
-- específica), versão do schema XML, correlation_id pra rastrear uma
-- tentativa de emissão ponta a ponta em nfe_eventos, e controle de
-- reconciliação pós-timeout (job consulta o protocolo antes de reemitir).
ALTER TABLE public.nfe
  ADD COLUMN IF NOT EXISTS ambiente text CHECK (ambiente IN ('homologacao', 'producao')),
  ADD COLUMN IF NOT EXISTS hash_xml_enviado text,
  ADD COLUMN IF NOT EXISTS hash_xml_autorizado text,
  ADD COLUMN IF NOT EXISTS versao_schema text NOT NULL DEFAULT '4.00',
  ADD COLUMN IF NOT EXISTS correlation_id uuid,
  ADD COLUMN IF NOT EXISTS enviada_em timestamptz,
  ADD COLUMN IF NOT EXISTS reconciliada boolean NOT NULL DEFAULT false;

-- Suporta a query do job de reconciliação: achar notas em 'enviada' há mais de
-- N minutos que ainda não foram reconciliadas (consulta de protocolo, nunca
-- reemissão).
CREATE INDEX IF NOT EXISTS idx_nfe_enviada_pendente ON public.nfe (enviada_em)
  WHERE status = 'enviada' AND reconciliada = false;
