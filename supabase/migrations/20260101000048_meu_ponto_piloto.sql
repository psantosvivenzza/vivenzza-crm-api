-- Módulo "Meu Ponto" — piloto interno de controle de ponto para funcionários
-- presenciais. NÃO é REP-P, não tem registro INPI, não gera AFD/AEJ, não usa
-- reconhecimento facial nem prova de vida. Ver
-- docs/meu-ponto/ESPECIFICACAO_MEU_PONTO.md para a decisão completa.
--
-- Decisões refletidas neste schema:
-- * Habilitação para bater ponto é uma flag por colaborador
--   (ponto_habilitacoes), não um novo valor de usuarios.role — evita mexer na
--   constraint usuarios_role_check em produção.
-- * ponto_config é uma trava mestra única (singleton): enquanto
--   piloto_ativo = false, nenhuma marcação real pode ser criada, mesmo que o
--   colaborador esteja habilitado. Deploy nunca liga isso sozinho.
-- * Identificação de equipamento (ponto_equipamentos/ponto_desafios) é
--   desenhada mas não aplicada nesta etapa — nasce em modo = 'demonstracao'.
-- * ponto_marcacoes é append-only: nada aqui apaga ou sobrescreve um
--   registro original. Correções (ponto_correcoes) só podem, se aprovadas,
--   gerar uma NOVA linha em ponto_marcacoes com origem = 'correcao'.
-- * Idempotência é por operacao_id (UUID gerado no cliente a cada toque),
--   não por (usuario, tipo, dia) — duas marcações legítimas do mesmo tipo no
--   mesmo dia não podem ser descartadas por engano; ficam sinalizadas para
--   revisão humana quando a sequência foge do esperado.

BEGIN;

-- 1. Trava mestra do piloto (linha única).
CREATE TABLE IF NOT EXISTS public.ponto_config (
  id boolean PRIMARY KEY DEFAULT true,
  piloto_ativo boolean NOT NULL DEFAULT false,
  atualizado_por uuid REFERENCES public.usuarios(id),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ponto_config_singleton CHECK (id)
);

INSERT INTO public.ponto_config (id, piloto_ativo)
VALUES (true, false)
ON CONFLICT (id) DO NOTHING;

-- 2. Habilitação explícita por colaborador (não é usuarios.role).
CREATE TABLE IF NOT EXISTS public.ponto_habilitacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL UNIQUE REFERENCES public.usuarios(id),
  habilitado boolean NOT NULL DEFAULT false,
  habilitado_por uuid REFERENCES public.usuarios(id),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ponto_habilitacoes_historico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  habilitado boolean NOT NULL,
  alterado_por uuid NOT NULL REFERENCES public.usuarios(id),
  alterado_em timestamptz NOT NULL DEFAULT now(),
  observacao text
);

CREATE INDEX IF NOT EXISTS idx_ponto_habilitacoes_historico_usuario
  ON public.ponto_habilitacoes_historico (usuario_id, alterado_em DESC);

-- 3. Escopo explícito de gestor de ponto (não é papel financeiro/admin).
CREATE TABLE IF NOT EXISTS public.ponto_gestores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gestor_usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  colaborador_usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  concedido_por uuid NOT NULL REFERENCES public.usuarios(id),
  concedido_em timestamptz NOT NULL DEFAULT now(),
  revogado_por uuid REFERENCES public.usuarios(id),
  revogado_em timestamptz,
  CONSTRAINT ponto_gestores_nao_e_o_proprio CHECK (gestor_usuario_id <> colaborador_usuario_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ponto_gestores_escopo_ativo
  ON public.ponto_gestores (gestor_usuario_id, colaborador_usuario_id)
  WHERE revogado_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_ponto_gestores_colaborador
  ON public.ponto_gestores (colaborador_usuario_id)
  WHERE revogado_em IS NULL;

-- 4. Equipamentos — cadastro/revogação; assinatura real fica para depois
-- (modo = 'demonstracao' enquanto o componente local não existir).
CREATE TABLE IF NOT EXISTS public.ponto_equipamentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid REFERENCES public.usuarios(id),
  identificador text NOT NULL,
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'revogado')),
  modo text NOT NULL DEFAULT 'demonstracao' CHECK (modo IN ('demonstracao', 'producao')),
  cadastrado_por uuid NOT NULL REFERENCES public.usuarios(id),
  cadastrado_em timestamptz NOT NULL DEFAULT now(),
  revogado_por uuid REFERENCES public.usuarios(id),
  revogado_em timestamptz
);

CREATE TABLE IF NOT EXISTS public.ponto_equipamento_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipamento_id uuid NOT NULL REFERENCES public.ponto_equipamentos(id),
  usuario_id uuid REFERENCES public.usuarios(id),
  evento text NOT NULL CHECK (evento IN ('vinculado', 'desvinculado', 'revogado', 'reativado')),
  executado_por uuid NOT NULL REFERENCES public.usuarios(id),
  executado_em timestamptz NOT NULL DEFAULT now(),
  observacao text
);

CREATE INDEX IF NOT EXISTS idx_ponto_equipamento_eventos_equipamento
  ON public.ponto_equipamento_eventos (equipamento_id, executado_em DESC);

-- 5. Desafio de uso único (nonce) para assinatura futura de operação por
-- equipamento — não é consumido por nada nesta etapa (modo demonstração).
CREATE TABLE IF NOT EXISTS public.ponto_desafios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipamento_id uuid NOT NULL REFERENCES public.ponto_equipamentos(id),
  nonce text NOT NULL UNIQUE,
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  usado_em timestamptz,
  operacao_id uuid
);

CREATE INDEX IF NOT EXISTS idx_ponto_desafios_equipamento
  ON public.ponto_desafios (equipamento_id, criado_em DESC);

-- 6. Metadados de foto — os bytes ficam só no bucket privado do Storage
-- (ponto-fotos), nunca em URL pública. Ver seção 2.4 da especificação.
CREATE TABLE IF NOT EXISTS public.ponto_fotos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  storage_path text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  tamanho_bytes integer NOT NULL CHECK (tamanho_bytes > 0 AND tamanho_bytes <= 5242880),
  capturada_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ponto_fotos_usuario
  ON public.ponto_fotos (usuario_id, criado_em DESC);

-- 7. Marcações — núcleo append-only. tipo organiza a interface mas não
-- bloqueia sequência inesperada (ver ponto_marcacoes_sinalizadas abaixo).
CREATE TABLE IF NOT EXISTS public.ponto_marcacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operacao_id uuid NOT NULL UNIQUE,
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  tipo text NOT NULL CHECK (tipo IN ('entrada', 'saida_intervalo', 'retorno_intervalo', 'saida')),
  origem text NOT NULL DEFAULT 'normal' CHECK (origem IN ('normal', 'contingencia', 'correcao')),
  registrado_em timestamptz NOT NULL DEFAULT now(),
  dia_brt date NOT NULL,
  foto_id uuid REFERENCES public.ponto_fotos(id),
  justificativa_contingencia text,
  equipamento_id uuid REFERENCES public.ponto_equipamentos(id),
  ip_registro inet,
  sinalizado_para_revisao boolean NOT NULL DEFAULT false,
  motivo_sinalizacao text,
  origem_correcao_id uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ponto_marcacoes_normal_exige_foto
    CHECK (origem <> 'normal' OR foto_id IS NOT NULL),
  CONSTRAINT ponto_marcacoes_contingencia_exige_justificativa
    CHECK (origem <> 'contingencia' OR justificativa_contingencia IS NOT NULL),
  CONSTRAINT ponto_marcacoes_correcao_exige_origem
    CHECK (origem <> 'correcao' OR origem_correcao_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_ponto_marcacoes_usuario_dia
  ON public.ponto_marcacoes (usuario_id, dia_brt, registrado_em);

CREATE INDEX IF NOT EXISTS idx_ponto_marcacoes_sinalizadas
  ON public.ponto_marcacoes (sinalizado_para_revisao, dia_brt)
  WHERE sinalizado_para_revisao;

-- 8. Correções — solicitação + decisão, nunca edita ponto_marcacoes direto.
--
-- Correção estrutural (auditoria adversarial de 2026-09-12, achado
-- independente da PR #78 original): ao contrário de ponto_marcacoes e
-- ponto_solicitacoes_marcacao, esta tabela nasceu sem operacao_id — POST
-- /api/ponto/correcoes não tinha nenhuma defesa contra retry de rede,
-- duplo clique ou reenvio concorrente, cada tentativa idêntica sempre
-- virava uma linha nova. Reproduzido contra Postgres real antes desta
-- correção: 2 chamadas HTTP sequenciais idênticas geravam 2 linhas; 5
-- chamadas simultâneas idênticas geravam 5. Ver
-- docs/meu-ponto/AUDITORIA_CORRECOES_DUPLICACAO_2026-09-12.md. operacao_id
-- aqui segue exatamente o mesmo padrão das duas tabelas irmãs (UNIQUE real
-- no banco, não só checagem em JS).
CREATE TABLE IF NOT EXISTS public.ponto_correcoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operacao_id uuid NOT NULL UNIQUE,
  marcacao_id uuid REFERENCES public.ponto_marcacoes(id),
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  tipo_solicitacao text NOT NULL CHECK (
    tipo_solicitacao IN ('ajuste_horario', 'ajuste_tipo', 'inclusao_marcacao_faltante', 'outro')
  ),
  valor_original jsonb,
  valor_proposto jsonb NOT NULL,
  justificativa text NOT NULL,
  solicitado_por uuid NOT NULL REFERENCES public.usuarios(id),
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovada', 'rejeitada')),
  decidido_por uuid REFERENCES public.usuarios(id),
  decidido_em timestamptz,
  decisao_justificativa text,
  CONSTRAINT ponto_correcoes_sem_autoaprovacao CHECK (decidido_por IS NULL OR decidido_por <> solicitado_por)
);

CREATE INDEX IF NOT EXISTS idx_ponto_correcoes_status
  ON public.ponto_correcoes (status, solicitado_em DESC);

CREATE INDEX IF NOT EXISTS idx_ponto_correcoes_usuario
  ON public.ponto_correcoes (usuario_id, solicitado_em DESC);

-- Referência cruzada (ponto_marcacoes.origem_correcao_id -> ponto_correcoes)
-- adicionada depois de ambas as tabelas existirem, para permitir o ciclo.
ALTER TABLE public.ponto_marcacoes
  ADD CONSTRAINT fk_ponto_marcacoes_origem_correcao
  FOREIGN KEY (origem_correcao_id) REFERENCES public.ponto_correcoes(id);

COMMIT;
