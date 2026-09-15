-- Correção estrutural (revisão de 2026-09-10): a migration anterior
-- (20260101000048) permitia que POST /api/ponto/marcacoes criasse uma
-- marcação origem='normal' direto, sem nenhuma verificação de equipamento,
-- assim que ponto_config.piloto_ativo=true — ou seja, "registro
-- operacional bloqueado" dependia inteiramente de um admin nunca ligar essa
-- flag, e não de uma ausência estrutural da capacidade que falta
-- (verificação criptográfica de equipamento, ainda não implementada). Isso
-- é exatamente o tipo de "proteção fraca" que a especificação original
-- pediu para nunca substituir silenciosamente o bloqueio real.
--
-- Esta tabela é o único caminho pelo qual uma marcação pode nascer
-- enquanto EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA (src/lib/ponto/equipamento.js)
-- for false: toda tentativa vira uma SOLICITAÇÃO auditada — com ou sem
-- foto, sempre com justificativa — e só produz uma linha real em
-- ponto_marcacoes (origem='contingencia', sinalizado_para_revisao=true)
-- depois de decisão humana explícita de um gestor. POST /api/ponto/marcacoes
-- (criação direta, origem='normal') continua existindo no código para
-- quando o componente de equipamento for implementado de verdade, mas fica
-- bloqueada por uma constante de código (não uma flag de banco) — ver
-- docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md, seção 2.5 revisada.

BEGIN;

CREATE TABLE IF NOT EXISTS public.ponto_solicitacoes_marcacao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operacao_id uuid NOT NULL UNIQUE,
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  tipo text NOT NULL CHECK (tipo IN ('entrada', 'saida_intervalo', 'retorno_intervalo', 'saida')),
  motivo text NOT NULL CHECK (motivo IN ('equipamento_nao_implementado', 'camera_indisponivel', 'outro')),
  justificativa text NOT NULL,
  capturado_em timestamptz NOT NULL DEFAULT now(),
  dia_brt date NOT NULL,
  foto_id uuid REFERENCES public.ponto_fotos(id),
  ip_registro inet,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovada', 'rejeitada')),
  decidido_por uuid REFERENCES public.usuarios(id),
  decidido_em timestamptz,
  decisao_justificativa text,
  marcacao_gerada_id uuid REFERENCES public.ponto_marcacoes(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ponto_solicitacoes_marcacao_sem_autoaprovacao CHECK (decidido_por IS NULL OR decidido_por <> usuario_id)
);

CREATE INDEX IF NOT EXISTS idx_ponto_solicitacoes_marcacao_status
  ON public.ponto_solicitacoes_marcacao (status, criado_em DESC);

CREATE INDEX IF NOT EXISTS idx_ponto_solicitacoes_marcacao_usuario
  ON public.ponto_solicitacoes_marcacao (usuario_id, criado_em DESC);

COMMIT;
