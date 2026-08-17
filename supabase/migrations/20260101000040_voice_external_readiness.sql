-- 2026-08-16 — prontidão para SIP trunk externo (Nvoip). Só o kill switch
-- (voice_external_enabled) — mesmo padrão de ai_voice_calls, mesma tabela,
-- mesmo default seguro (false). Sem PATCH route pra este campo de propósito
-- (mesmo padrão de ai_voice_calls hoje: só SQL direto por um operador,
-- nunca exposto num toggle de UI) — reduz superfície de ativação acidental
-- nesta fase de prontidão.
--
-- NÃO altera:
-- - voice_calls (migration 20260101000033, já existe, continua não aplicada
--   em produção por decisão separada — este arquivo não depende dela);
-- - destinoResolver.js (TRUNK_EXTERNO_CONFIGURADO continua false no código,
--   hardcoded — esta coluna sozinha nunca libera uma chamada real, é só
--   mais um dos vários guards que avaliarAutorizacaoChamadaExterna() exige
--   simultaneamente).
ALTER TABLE automacoes_config
  ADD COLUMN IF NOT EXISTS voice_external_enabled boolean NOT NULL DEFAULT false;
