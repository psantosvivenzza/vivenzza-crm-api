-- Módulo de Estoque — Vivenzza ERP
-- Execute este script no Supabase SQL Editor

-- Tabela principal de saldos por produto
CREATE TABLE IF NOT EXISTS estoque (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id    UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade    NUMERIC(14, 4) NOT NULL DEFAULT 0,
  quantidade_minima NUMERIC(14, 4) NOT NULL DEFAULT 0,
  unidade       VARCHAR(20) NOT NULL DEFAULT 'un',
  localizacao   VARCHAR(100),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(produto_id)
);

-- Histórico de movimentações
CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id    UUID NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  tipo          VARCHAR(20) NOT NULL CHECK (tipo IN ('entrada', 'saida', 'ajuste')),
  quantidade    NUMERIC(14, 4) NOT NULL,
  motivo        VARCHAR(255),
  documento_ref VARCHAR(100),
  usuario_id    UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consultas frequentes
CREATE INDEX IF NOT EXISTS idx_movimentacoes_produto ON movimentacoes_estoque(produto_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_created ON movimentacoes_estoque(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_estoque_produto ON estoque(produto_id);

-- Trigger para atualizar o updated_at do estoque ao receber movimentação
CREATE OR REPLACE FUNCTION atualizar_saldo_estoque()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.tipo = 'entrada' THEN
    INSERT INTO estoque (produto_id, quantidade)
      VALUES (NEW.produto_id, NEW.quantidade)
      ON CONFLICT (produto_id)
      DO UPDATE SET
        quantidade = estoque.quantidade + NEW.quantidade,
        updated_at = NOW();
  ELSIF NEW.tipo = 'saida' THEN
    INSERT INTO estoque (produto_id, quantidade)
      VALUES (NEW.produto_id, -NEW.quantidade)
      ON CONFLICT (produto_id)
      DO UPDATE SET
        quantidade = estoque.quantidade - NEW.quantidade,
        updated_at = NOW();
  ELSIF NEW.tipo = 'ajuste' THEN
    INSERT INTO estoque (produto_id, quantidade)
      VALUES (NEW.produto_id, NEW.quantidade)
      ON CONFLICT (produto_id)
      DO UPDATE SET
        quantidade = NEW.quantidade,
        updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_atualizar_saldo ON movimentacoes_estoque;
CREATE TRIGGER trg_atualizar_saldo
AFTER INSERT ON movimentacoes_estoque
FOR EACH ROW EXECUTE FUNCTION atualizar_saldo_estoque();
