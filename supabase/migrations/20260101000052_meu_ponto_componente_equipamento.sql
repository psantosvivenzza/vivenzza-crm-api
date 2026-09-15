-- Meu Ponto — componente de identificação de equipamento (implementação).
--
-- IMPORTANTE: esta migration NÃO muda EQUIPAMENTO_VERIFICACAO_IMPLEMENTADA
-- (src/lib/ponto/equipamento.js) para true, e não é, por si só, capaz de
-- ativar marcação direta em produção — isso continua exigindo uma mudança
-- de código separada e revisada (ver docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md).
--
-- O que esta migration adiciona:
-- 1. Cadastro supervisionado de equipamento: chave pública (JWK), sinalização
--    de hardware-backed, e código de vínculo de uso único (tabela nova).
-- 2. Desafio vinculado a usuário/operação/conteúdo, com autenticidade do
--    desafio garantida por HMAC-SHA256 (segredo por equipamento, gerado no
--    cadastro, nunca reaproveitado entre equipamentos).
--
-- Nenhuma criptografia própria: HMAC-SHA256 e ECDSA P-256 são primitivas
-- padrão. Ver docs/meu-ponto/PROTOCOLO_COMPONENTE_WINDOWS.md para o
-- protocolo completo e os testes reais que validaram os formatos usados.

BEGIN;

-- 1. Cadastro supervisionado — código de vínculo de uso único.
-- O colaborador NUNCA pode gerar isto sozinho: só nasce de uma ação de admin
-- (POST /api/ponto-admin/equipamentos, estendido nesta etapa).
CREATE TABLE IF NOT EXISTS public.ponto_equipamento_vinculos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipamento_id uuid NOT NULL REFERENCES public.ponto_equipamentos(id),
  codigo text NOT NULL UNIQUE,
  criado_por uuid NOT NULL REFERENCES public.usuarios(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  expira_em timestamptz NOT NULL,
  usado_em timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ponto_equipamento_vinculos_equipamento
  ON public.ponto_equipamento_vinculos (equipamento_id, criado_em DESC);

-- 2. Chave pública do equipamento (JWK EC P-256), sinalização de
-- hardware-backed (informativa — nunca uma prova remotamente atestada, ver
-- protocolo §2), e segredo HMAC próprio deste equipamento para autenticar
-- desafios perante o serviço local (não é a chave privada do equipamento —
-- essa nunca sai do CNG; este segredo só prova "este desafio veio do
-- backend", não prova nada sobre quem está operando o equipamento).
ALTER TABLE public.ponto_equipamentos
  ADD COLUMN IF NOT EXISTS chave_publica_jwk jsonb,
  ADD COLUMN IF NOT EXISTS chave_hardware_backed boolean,
  ADD COLUMN IF NOT EXISTS vinculado_em timestamptz,
  ADD COLUMN IF NOT EXISTS desafio_hmac_secret text;

-- Um equipamento só pode estar em modo='producao' se já tiver, de fato,
-- completado o cadastro real de chave (evita que alguém marque modo manualmente
-- sem nunca ter passado pelo protocolo de 8 passos).
ALTER TABLE public.ponto_equipamentos
  DROP CONSTRAINT IF EXISTS ponto_equipamentos_producao_exige_chave;
ALTER TABLE public.ponto_equipamentos
  ADD CONSTRAINT ponto_equipamentos_producao_exige_chave
  CHECK (
    modo <> 'producao'
    OR (chave_publica_jwk IS NOT NULL AND chave_hardware_backed IS NOT NULL AND desafio_hmac_secret IS NOT NULL)
  );

-- Novo tipo de evento de auditoria: registro de chave bem-sucedido.
ALTER TABLE public.ponto_equipamento_eventos
  DROP CONSTRAINT IF EXISTS ponto_equipamento_eventos_evento_check;
ALTER TABLE public.ponto_equipamento_eventos
  ADD CONSTRAINT ponto_equipamento_eventos_evento_check
  CHECK (evento IN ('vinculado', 'desvinculado', 'revogado', 'reativado', 'chave_registrada'));

-- 3. Desafio — vincula usuário, tipo, e hash do conteúdo (ex.: foto) à
-- assinatura que o serviço local vai produzir, além do equipamento já
-- existente na tabela. assinatura_servidor é o HMAC (hex) calculado pelo
-- backend sobre os campos canônicos do desafio, usando
-- ponto_equipamentos.desafio_hmac_secret — é isto que o serviço local
-- confere antes de aceitar assinar (protocolo §1, passo 4).
ALTER TABLE public.ponto_desafios
  ADD COLUMN IF NOT EXISTS usuario_id uuid REFERENCES public.usuarios(id),
  ADD COLUMN IF NOT EXISTS tipo text,
  ADD COLUMN IF NOT EXISTS hash_conteudo text,
  ADD COLUMN IF NOT EXISTS assinatura_servidor text;

ALTER TABLE public.ponto_desafios
  DROP CONSTRAINT IF EXISTS ponto_desafios_tipo_check;
ALTER TABLE public.ponto_desafios
  ADD CONSTRAINT ponto_desafios_tipo_check
  CHECK (tipo IS NULL OR tipo IN ('entrada', 'saida_intervalo', 'retorno_intervalo', 'saida'));

CREATE INDEX IF NOT EXISTS idx_ponto_desafios_usuario
  ON public.ponto_desafios (usuario_id, criado_em DESC);

COMMIT;
