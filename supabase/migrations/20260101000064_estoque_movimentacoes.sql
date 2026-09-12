-- GAP DE VERSIONAMENTO — estoque / movimentacoes_estoque /
-- atualizar_saldo_estoque() / trg_atualizar_saldo existiam só em
-- migrations/estoque.sql (pasta solta, fora do pipeline real:
-- scripts/localdb-reset.mjs só aplica scripts/localdb/schema-baseline/ +
-- supabase/migrations/, nunca migrations/) — mesma classe de gap já fechada
-- em 20260101000057-000061 para estornos_financeiros/fn_baixar_titulo e
-- 20260101000055 para fn_sincronizar_baixa_legado (PR #77).
--
-- ACHADO CRÍTICO — DRIFT confirmado entre migrations/estoque.sql e o corpo
-- real de atualizar_saldo_estoque() em produção (confirmado via SQL Editor,
-- ver docs/financeiro/schema-real-producao-dre-notas-entrada.md): a versão
-- legada solta NÃO tem `SET search_path TO 'public', 'pg_temp'` — hardening
-- de search_path presente na função REAL em produção, provavelmente
-- adicionado manualmente depois da criação original e nunca sincronizado de
-- volta pro arquivo solto. Corpo abaixo é o texto CONFIRMADO real (com o
-- hardening), não o texto do arquivo legado desatualizado.
--
-- CREATE TRIGGER puro (sem IF NOT EXISTS na sintaxe do Postgres) trocado por
-- DROP TRIGGER IF EXISTS + CREATE TRIGGER, mesmo padrão já usado em
-- scripts/localdb/schema-baseline-financeiro-repro/004_estoque.sql — idempotente,
-- sem alterar nome/evento/granularidade do trigger real.
--
-- Verificação pendente (sem acesso a produção real nesta sessão) — ver
-- consultas read-only prontas em
-- docs/financeiro/verificacao-producao-notas-entrada-dre.md antes de aplicar
-- esta migration em produção.

CREATE TABLE IF NOT EXISTS public.estoque (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id        uuid NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  quantidade        numeric(14,4) NOT NULL DEFAULT 0,
  quantidade_minima numeric(14,4) NOT NULL DEFAULT 0,
  unidade           varchar(20) NOT NULL DEFAULT 'un',
  localizacao       varchar(100),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  legacy_id         text,
  CONSTRAINT estoque_produto_id_key UNIQUE (produto_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS estoque_legacy_id_uk ON public.estoque (legacy_id);
CREATE INDEX IF NOT EXISTS idx_estoque_produto ON public.estoque (produto_id);

CREATE TABLE IF NOT EXISTS public.movimentacoes_estoque (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  produto_id    uuid NOT NULL REFERENCES public.produtos(id) ON DELETE CASCADE,
  tipo          varchar(20) NOT NULL CHECK (tipo IN ('entrada', 'saida', 'ajuste')),
  quantidade    numeric(14,4) NOT NULL,
  motivo        varchar(255),
  documento_ref varchar(100),
  usuario_id    uuid REFERENCES public.usuarios(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  legacy_id     text,
  lote_id       uuid REFERENCES public.lotes_estoque(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS movimentacoes_estoque_legacy_id_uk ON public.movimentacoes_estoque (legacy_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_produto ON public.movimentacoes_estoque (produto_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_created ON public.movimentacoes_estoque (created_at DESC);

-- Definição VERBATIM confirmada em produção (com o hardening de search_path
-- — ver ACHADO CRÍTICO acima) — nenhuma linha de lógica de negócio alterada.
CREATE OR REPLACE FUNCTION public.atualizar_saldo_estoque()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

-- DDL do CREATE TRIGGER confirmada verbatim (nome, evento, granularidade).
DROP TRIGGER IF EXISTS trg_atualizar_saldo ON public.movimentacoes_estoque;
CREATE TRIGGER trg_atualizar_saldo
AFTER INSERT ON public.movimentacoes_estoque
FOR EACH ROW EXECUTE FUNCTION public.atualizar_saldo_estoque();
