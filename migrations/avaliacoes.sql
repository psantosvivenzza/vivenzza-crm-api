-- Avaliações (loja própria + cache de Google Reviews) — Vivenzza
-- Execute este script no Supabase SQL Editor

-- Avaliações enviadas pelo formulário público da loja. Entram com
-- aprovado=false e só aparecem no GET público depois de moderação manual.
CREATE TABLE IF NOT EXISTS avaliacoes_loja (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_cliente   TEXT NOT NULL,
  email          TEXT,
  nota           INTEGER NOT NULL CHECK (nota BETWEEN 1 AND 5),
  comentario     TEXT NOT NULL,
  produto_id     TEXT,
  aprovado       BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_avaliacoes_loja_aprovado_criado ON avaliacoes_loja(aprovado, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_avaliacoes_loja_produto ON avaliacoes_loja(produto_id);

-- Cache das Google Reviews (Place Details API) — linha única (id fixo em 1),
-- atualizada no máximo 1x por dia pelo endpoint GET /api/google-reviews.
CREATE TABLE IF NOT EXISTS google_reviews_cache (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  rating              NUMERIC(2, 1),
  user_ratings_total  INTEGER,
  reviews             JSONB,
  atualizado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);
