-- Módulo de cobrança financeira (Aging Report + régua de cobrança via WhatsApp)
-- Execute este script no Supabase SQL Editor

-- 1) contas_financeiras ganha 2 colunas nullable — não quebra nada existente.
--    vendedor_id: preenchido via backfill (títulos com pedido_id) ou na criação
--    de nova parcela (pedidos.js). Fica NULL pros ~1.400 títulos legados — não
--    existe vínculo confiável de vendedor pra eles (decisão registrada no plano).
--    telefone_cobranca: preenchido pelo script de backfill (auto-match por nome
--    contra clientes_erp.contatos), sempre editável na tela do Aging Report.
ALTER TABLE public.contas_financeiras
  ADD COLUMN IF NOT EXISTS vendedor_id uuid REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS telefone_cobranca text;

CREATE INDEX IF NOT EXISTS idx_contas_financeiras_vendedor_id ON public.contas_financeiras (vendedor_id);

-- 2) Histórico de disparos da régua de cobrança.
CREATE TABLE IF NOT EXISTS public.cobrancas_whatsapp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contas_financeiras_id uuid REFERENCES public.contas_financeiras(id),
  cliente_nome text NOT NULL,
  cliente_telefone text NOT NULL,
  valor numeric NOT NULL,
  vencimento date,
  dias_atraso integer,
  etapa integer NOT NULL CHECK (etapa BETWEEN 1 AND 5),
  status text NOT NULL DEFAULT 'enviada' CHECK (status IN ('pendente', 'enviada', 'respondida', 'paga')),
  origem text NOT NULL CHECK (origem IN ('cron', 'manual')),
  data_envio timestamptz,
  data_resposta timestamptz,
  mensagem_enviada text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Garante no banco (não só na aplicação) que a régua automática nunca manda a
-- mesma etapa duas vezes pro mesmo título. Disparo manual não entra nessa
-- trava (é ação humana deliberada, pode repetir) — por isso o índice único é
-- parcial, só sobre origem='cron'.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobrancas_whatsapp_cron_unico
  ON public.cobrancas_whatsapp (contas_financeiras_id, etapa)
  WHERE origem = 'cron';

CREATE INDEX IF NOT EXISTS idx_cobrancas_whatsapp_status ON public.cobrancas_whatsapp (status);

-- 3) Kill-switch da régua automática — mesmo padrão de automacoes_config.reativacao_ativa.
--    Desligado por padrão: nem o cron diário nem o disparo em massa mandam
--    nada até ser ligado explicitamente pela tela de Cobranças.
ALTER TABLE public.automacoes_config
  ADD COLUMN IF NOT EXISTS cobranca_whatsapp_ativa boolean NOT NULL DEFAULT false;
