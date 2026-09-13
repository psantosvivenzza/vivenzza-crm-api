-- Baseline LOCAL apenas — contatos já existe em produção (criada fora de
-- controle de versão), mas não fazia parte do schema local de teste até
-- agora. Sem isso, src/routes/contatos.js não tinha NENHUMA cobertura de
-- teste local possível — achado colateral da auditoria de 2026-09-13
-- (posse por vendedor ausente em contatos.js, via lead_id -> leads.responsavel_id).
CREATE TABLE IF NOT EXISTS public.contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  nome text NOT NULL,
  email text,
  telefone text,
  empresa text,
  cargo text,
  observacoes text,
  principal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_contatos_lead_id ON public.contatos(lead_id);
