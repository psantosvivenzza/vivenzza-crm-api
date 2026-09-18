-- 2026-09-17 — campos que a régua de tentativas e o painel da Central de Voz
-- precisam, além do núcleo de auditoria de 20260101000033_voice_calls_audit.sql
-- (que só foi APLICADO nesta data — antes disso o histórico de chamadas era
-- um stub vazio e TODOS os limites de ligação estavam inertes).

-- telefone_hash: SHA-256 do número em E.164. Permite contar tentativas por
-- cliente SEM guardar o telefone em texto plano em lugar nenhum.
ALTER TABLE public.voice_calls
  ADD COLUMN IF NOT EXISTS telefone_hash text,
  ADD COLUMN IF NOT EXISTS codigo_cliente text,
  ADD COLUMN IF NOT EXISTS cliente_nome text,
  ADD COLUMN IF NOT EXISTS numero_origem text,
  ADD COLUMN IF NOT EXISTS campanha text,
  ADD COLUMN IF NOT EXISTS tentativa_numero integer,
  ADD COLUMN IF NOT EXISTS ciclo_iniciado_em date,
  ADD COLUMN IF NOT EXISTS proxima_tentativa_em timestamptz,
  ADD COLUMN IF NOT EXISTS faixa_horario text,
  ADD COLUMN IF NOT EXISTS transcricao text,
  ADD COLUMN IF NOT EXISTS gravacao_path text,
  ADD COLUMN IF NOT EXISTS valor_prometido numeric,
  ADD COLUMN IF NOT EXISTS data_prometida date,
  ADD COLUMN IF NOT EXISTS cobranca_whatsapp_id uuid REFERENCES public.cobrancas_whatsapp(id);

CREATE INDEX IF NOT EXISTS idx_voice_calls_telefone_ciclo
  ON public.voice_calls (telefone_hash, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_criado_em
  ON public.voice_calls (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_codigo_cliente
  ON public.voice_calls (codigo_cliente, criado_em DESC);

COMMENT ON COLUMN public.voice_calls.telefone_hash IS 'SHA-256 do telefone em E.164 — chave de contagem por cliente sem guardar o número em texto plano';
COMMENT ON COLUMN public.voice_calls.tentativa_numero IS 'Posição na régua de 10 tentativas do ciclo corrente';
COMMENT ON COLUMN public.voice_calls.faixa_horario IS 'MANHA | TARDE | INICIO_DIA | FIM_TARDE — usado para medir taxa de atendimento por faixa';
