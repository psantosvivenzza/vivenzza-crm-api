-- Voice AI EXTERNAL PILOT READINESS — auditoria de chamadas de voz
-- (inbound e outbound). Nenhuma chamada EXTERNA acontece nesta rodada (sem
-- trunk configurado, ver destinoResolver.js) — esta tabela é preparação de
-- schema, hoje só populável pelos testes internos (PJSIP/7001, já
-- homologados nos PR #18/#19) e por fixtures sintéticas.
--
-- Nunca guarda segredo. destination_masked NUNCA é o telefone completo em
-- texto plano em nenhum contexto que vaze pra log comum (mascarar últimos
-- 4 dígitos, mesmo padrão já usado no motor de cobrança por WhatsApp).
CREATE TABLE IF NOT EXISTS public.voice_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id text NOT NULL UNIQUE, -- id do canal Asterisk/ARI
  direction text NOT NULL, -- inbound | outbound
  destination_type text NOT NULL DEFAULT 'INTERNAL', -- INTERNAL | EXTERNAL (ver TIPO_DESTINO em destinoResolver.js)
  destination_masked text NOT NULL, -- ex: 'PJSIP/7001' ou telefone mascarado (só os últimos 4 dígitos)
  conta_id uuid REFERENCES public.contas_financeiras(id), -- nullable: testes internos/fixture não têm conta real
  status text NOT NULL DEFAULT 'CREATED', -- ver RESULTADOS_TECNICOS em voiceCallResult.js
  intent_final text, -- ver RESULTADOS_CONVERSACIONAIS (= INTENTS de intentClassifier.js)
  requires_human boolean NOT NULL DEFAULT false,
  idempotency_key text UNIQUE, -- obrigatória pra qualquer chamada EXTERNAL (ver externalPilotGuardrails.js); nula em testes internos
  started_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  hangup_cause text,
  failure_class text, -- NO_ANSWER | BUSY | FAILED | CANCELLED, quando aplicável
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON public.voice_calls (status, criado_em);
CREATE INDEX IF NOT EXISTS idx_voice_calls_conta_id ON public.voice_calls (conta_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_destination_type ON public.voice_calls (destination_type, criado_em);
