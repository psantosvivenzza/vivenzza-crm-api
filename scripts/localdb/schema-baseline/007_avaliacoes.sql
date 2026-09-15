-- Baseline LOCAL/TESTE — espelha migrations/avaliacoes.sql (aplicada
-- manualmente em produção via Supabase SQL Editor, nunca versionada como
-- migration git em supabase/migrations/). Sem isso, src/routes/avaliacoes.js
-- e src/routes/avaliacoes-admin.js não tinham NENHUMA cobertura de teste
-- local possível — achado colateral da auditoria de 2026-09-13
-- (adminOnly ausente em /api/admin/avaliacoes).
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
