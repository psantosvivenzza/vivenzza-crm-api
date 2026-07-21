-- Atribuição por criativo (Click-to-WhatsApp) — Vivenzza
-- Execute este script no Supabase SQL Editor

-- ctwa_clid: Click-to-WhatsApp Click ID enviado pela Meta quando o lead chega
-- via clique num anúncio de clique-pra-WhatsApp. Permite atribuição por
-- criativo/anúncio específico dentro de uma campanha (campanha_origem já
-- identifica a campanha, mas não o anúncio individual). Capturado só na
-- primeira mensagem que cria o lead — ver src/routes/webhook-handler.js.
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
