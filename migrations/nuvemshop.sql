-- Integração Nuvemshop (Blog) — Vivenzza
-- Execute este script no Supabase SQL Editor

-- Credenciais OAuth da loja conectada. UNIQUE(store_id) é exigido pelo
-- upsert(onConflict: 'store_id') em src/lib/nuvemshop.js — sem o índice
-- único o upsert falha silenciosamente (não dá erro, mas insere duplicata
-- em vez de atualizar).
CREATE TABLE IF NOT EXISTS nuvemshop_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id      TEXT NOT NULL,
  access_token  TEXT NOT NULL,
  token_type    TEXT,
  scope         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(store_id)
);

-- Log de publicações em canais omnichannel (hoje só blog Nuvemshop, mas
-- a coluna "canal" já permite estender para outros canais no futuro).
CREATE TABLE IF NOT EXISTS publicacoes_omnichannel (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canal         TEXT NOT NULL,
  titulo        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('sucesso', 'erro')),
  post_url      TEXT,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  erro_detalhe  TEXT
);

CREATE INDEX IF NOT EXISTS idx_publicacoes_omnichannel_criado_em ON publicacoes_omnichannel(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_publicacoes_omnichannel_canal ON publicacoes_omnichannel(canal);
