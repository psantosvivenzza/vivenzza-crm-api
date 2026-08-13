# Voice AI MVP — scripts locais

## O que já foi testado (fora do contexto de chamada)

Nesta sessão, rodei um harness local (não commitado — era um script de
diagnóstico em `/tmp`, reescrito aqui como `stt_transcribe.py`/
`tts_synthesize.py` para virar parte do produto) provando ponta a ponta:

1. Texto simulando cliente → Piper TTS → áudio (~2.4s)
2. Áudio → faster-whisper STT → texto transcrito (~5.2s, transcrição correta)
3. Texto → MESMO cérebro do WhatsApp (`intentClassifier`+`replySuggestion`+
   Ollama `qwen2.5:7b-instruct`) → intent + resposta (~7.9s)
4. Resposta → Piper TTS → áudio de resposta (~2.5s)

Resultado real: `intent=PEDIDO_NOVA_DATA`, `requires_human=false`, resposta
gerada coerente ("Compreendemos sua situação. Se puder, por favor, nos
informe a data exata de pagamento...").

## Ligação real — homologada com sucesso

Depois que WSL2 + Asterisk ficaram disponíveis, a ligação interna completa
foi testada de verdade: ramal 7001 (MicroSIP) → 8001 → Stasis → saudação
ouvida → fala capturada → STT → IA → TTS → resposta ouvida → 2 turnos
completos → hangup limpo pelo próprio serviço. Ver
`config/asterisk/README.md` para os 3 achados que precisaram de correção
no caminho (diretório real de sons via symlink, formato de áudio ulaw,
latência/feedback imediato) — nenhum deles bloqueia mais nada, documentados
lá para quem for reproduzir o setup.

`diag-service.mjs` é o harness de diagnóstico isolado (só `tone:ring`, sem
TTS/STT/IA) que ajudou a provar que a camada SIP/ARI/Asterisk estava
saudável antes de investigar o resto — útil pra qualquer futuro
troubleshooting de infraestrutura sem misturar com bugs de aplicação.

## Dependências Python

```
pip install faster-whisper piper-tts
python -m piper.download_voices --download-dir <pasta> pt_BR-faber-medium
```

## Workers persistentes de STT/TTS (endurecimento pós-PR #17)

`stt_transcribe.py`/`tts_synthesize.py` (scripts avulsos, um processo
Python novo por requisição) recarregavam o modelo do ZERO em todo turno —
~2.3s (Whisper) + ~2s (Piper) de `load_ms` pagos repetidamente, o maior
gargalo medido numa ligação real homologada (ver PR #17).

`stt_worker.py`/`tts_worker.py` são a versão PERSISTENTE: sobem uma vez na
inicialização do serviço (`iniciarServicoVoz()`), carregam o modelo uma
única vez, e respondem requisições via stdin/stdout (protocolo JSON de uma
linha por mensagem) enquanto o processo viver — ver `pyWorkerClient.js`.
`sttBridge.js`/`ttsBridge.js` usam o worker automaticamente quando ele está
pronto; se o worker não subiu ainda ou morreu (excedeu o limite de
restarts), caem pro script avulso antigo como fallback — sempre logando a
degradação (`STT_WORKER indisponível...`/`TTS_WORKER indisponível...`),
nunca mascarando em silêncio.

Antes de pedir uma ligação real, rode o smoke test local (sem Asterisk):

```
node scripts/voice/smoke-test-workers.mjs
```

Ele sobe os dois workers, confirma `load_ms` só na 1ª requisição de cada, e
faz 3 sínteses + 3 transcrições consecutivas medindo a latência de cada
uma — prova que o modelo não está recarregando por turno.

## Escolha de voz — Piper pt_BR-jeff-medium (homologado)

Depois do PR #17 (latência), uma ligação real revelou UX ruim de voz —
investigada nesta ordem, cada hipótese testada por ouvido humano ANTES de
mudar produção (nenhum benchmark numérico decide sozinho aqui):

1. `length_scale=1.10` (10% mais devagar) foi tentado pra melhorar
   inteligibilidade — REJEITADO: mesmo ouvindo o `.wav` bruto fora de
   qualquer telefonia, a voz `pt_BR-faber-medium` soou "rápida/estranha".
   Descartou hipótese de bug de codec/sample-rate/resample (todos os
   estágios do pipeline foram inspecionados e batem exatamente —
   `diag_tts_pipeline.py`).
2. Comparação lado a lado das 3 vozes Piper pt-BR disponíveis
   (faber/cadu/jeff) com `length_scale=1.00` (`gerar_comparacao_vozes.py`)
   — **JEFF aprovado** pelo ouvido.
3. Ligação real com Jeff revelou "chiado" — investigado com
   `diag_standalone_vs_worker.py` (checksum do modelo, parâmetros de
   síntese e estatísticas de ruído idênticos entre o script standalone e o
   worker persistente — não é bug de pipeline) e `gerar_teste_noise_scale.py`
   (teste controlado A/B/C de `noise_scale` 0.667/0.30/0.00 com 3
   repetições cada — as 3 configs saíram "limpas" ao ouvido, então
   `noise_scale` NÃO era a causa do chiado isolado; mantido no default).
4. Configuração final homologada por ligação real: `pt_BR-jeff-medium`,
   `length_scale=1.00`, `noise_scale`/`noise_w` = default do modelo (nunca
   sobrescritos), `preroll=200ms`.

Scripts de diagnóstico ficaram no repo (mesmo espírito do `diag-service.mjs`
pra infra — reprodutibilidade futura se a voz precisar ser revisitada):
`benchmark_tts_speed.py`, `gerar_comparacao_vozes.py`,
`diag_tts_pipeline.py`, `diag_standalone_vs_worker.py`,
`gerar_teste_noise_scale.py`. Todos geram `.wav` locais (fora do
`\\wsl$`/Asterisk) pra decisão por ouvido, nunca mudam produção sozinhos.

## Preservação automática do áudio da última ligação

Pra nunca precisar "regenerar pra investigar" (o Piper tem variação
estocástica entre gerações — reexecutar não reproduz o mesmo áudio), toda
`StasisStart` limpa e recria uma pasta local com cópia exata do que tocou
naquela chamada: `01-saudacao.wav`, `02-feedback.wav`,
`03-resposta-turno1.wav`, `04-resposta-turno2.wav`... Path configurável via
`VOICE_LAST_CALL_DIAG_DIR` (default `C:\Users\<usuário>\AppData\Local\Temp\vivenzza-last-call`).

## Env necessárias (nunca commitadas)

```
VOICE_PYTHON_BIN=python
VOICE_STT_MODEL=small
VOICE_TTS_MODEL_PATH=<caminho absoluto para o .onnx do Piper — pt_BR-jeff-medium.onnx homologado>

# fallback (script avulso, só usado se o worker não estiver disponível)
VOICE_STT_SCRIPT_PATH=<caminho absoluto para stt_transcribe.py>
VOICE_TTS_SCRIPT_PATH=<caminho absoluto para tts_synthesize.py>

# opcional — só se os workers não estiverem em scripts/voice/stt_worker.py
# e scripts/voice/tts_worker.py (caminho default já resolvido em runtime)
VOICE_STT_WORKER_SCRIPT_PATH=<caminho absoluto para stt_worker.py>
VOICE_TTS_WORKER_SCRIPT_PATH=<caminho absoluto para tts_worker.py>

# opcional — timeout esperando os workers ficarem prontos na subida (default 60000ms)
VOICE_WORKER_READY_TIMEOUT_MS=60000

# opcional — calibragem de voz homologada (defaults já batem: length_scale=1.00, preroll=200ms)
VOICE_TTS_LENGTH_SCALE=1.00
VOICE_TTS_PREROLL_MS=200

# opcional — pasta de diagnóstico da última ligação (default já mostrado acima)
VOICE_LAST_CALL_DIAG_DIR=C:\Users\<usuário>\AppData\Local\Temp\vivenzza-last-call
```

## Outbound interno — homologado (PR #19)

Além de receber ligação (8001), o serviço consegue ORIGINAR uma ligação de
teste pro ramal interno: `npm run voice:outbound:test` (dry-run por
padrão; `--confirm` pra originar de verdade). Único destino permitido é
`PJSIP/7001` — fail-closed em código (`outboundInternalTest.js`), sem
parâmetro de destino em lugar nenhum do fluxo. Homologado numa ligação
real: origem → toque → atendimento → saudação Jeff → STT → intent → TTS →
encerramento limpo.

## VOICE EXTERNAL PILOT READINESS (preparação, sem chamada externa ainda)

Nenhuma chamada para número externo acontece nesta fase — só a
arquitetura de guardrails, testada sem tocar telefone nenhum:

- `destinoResolver.js` — abstrai `INTERNAL` (resolve pro mesmo
  `PJSIP/7001` já homologado) de `EXTERNAL` (sempre falha fechado nesta
  rodada — não há trunk/adapter configurado; o único jeito de mudar isso é
  editar a constante `TRUNK_EXTERNO_CONFIGURADO` DEPOIS que um trunk real
  existir).
- `externalPilotGuardrails.js` — `avaliarAutorizacaoChamadaExterna()`
  combina TODOS os guards (flag `voice_external_enabled`, allowlist,
  idempotência, chamada duplicada ativa, janela de horário — fail-closed
  sem política configurada, limite diário por telefone) e só autoriza se
  TODOS passarem. Sem trunk configurado, o primeiro guard já bloqueia
  sempre, então nenhuma combinação de flags "engana" o sistema pra ligar
  de verdade nesta fase.
- `voiceCallResult.js` — vocabulário de RESULTADO TÉCNICO (canal: tocou?
  atendeu? caiu?) separado de RESULTADO CONVERSACIONAL (intent final —
  reexporta `INTENTS` do `intentClassifier.js` compartilhado com o
  WhatsApp, nunca duplica a taxonomia).
- `collectionContextFixture.js` — fixture SINTÉTICA da interface que uma
  integração real com o ERP/CRM vai precisar preencher um dia
  (contaId/pessoaId/tituloId/telefone/valor/vencimento/régua). Nenhuma
  busca real, nenhum cron.
- `promiseCandidateDetector.js` — se o cliente disser algo como "pago
  sexta", vira `promise_candidate` (rótulo pra revisão humana) — NUNCA
  cria promessa real, NUNCA baixa título, NUNCA muta financeiro.
- `supabase/migrations/20260101000033_voice_calls_audit.sql` — schema de
  auditoria (`call_id`, `direction`, `destination_masked`,
  `idempotency_key`, resultado técnico/conversacional, timestamps, causa
  de encerramento). **Criada mas NÃO aplicada em produção nesta rodada**
  (nem local) — fica pra revisão antes de qualquer chamada externa real.

### Estratégia de handoff pro atendente — decisão pendente

`QUERO_ATENDENTE`/`requires_human=true` continua preservado e obrigatório
(regra determinística da PARTE B, PR #17). O que ainda falta decidir,
ANTES de qualquer cliente real, é o que acontece tecnicamente quando isso
dispara numa ligação externa — três caminhos possíveis, nenhum implementado
ainda porque não existe ramal humano disponível pra transferir:

1. **Transferência real** (`channel.continueInDialplan`/bridge pra um
   ramal humano) — exige um ramal humano real configurado no Asterisk.
2. **Callback** — a IA encerra educadamente e registra um pedido de
   retorno humano (via `voice_calls`), sem tentar transferir ao vivo.
3. **Tarefa pro operador** — cria uma tarefa/alerta (reaproveitando o
   endpoint de alerta WhatsApp já existente) sem nenhuma ação na própria
   ligação além de encerrar.

### O que falta pra UMA chamada externa de teste (não contratado nesta rodada)

1. **Trunk SIP** de algum provedor (ex: opções self-hosted/gratuitas
   costumam não existir pra SIP trunk real — normalmente é um serviço
   pago por minuto/número; decisão de fornecedor fica pra quando formos
   avançar, respeitando a preferência por free/self-hosted onde existir
   alternativa real).
2. **Um número de teste NOSSO** (não do cliente) pra ligar — celular ou
   fixo próprio, cadastrado na allowlist.
3. Configuração do trunk no `pjsip.conf` (novo endpoint/registration, tudo
   isolado do `PJSIP/7001` interno que já funciona — não deve alterar a
   config interna existente).
4. Decisão de estratégia de handoff (seção acima) — pelo menos a opção 2
   ou 3 (callback/tarefa) dá pra implementar sem depender de ramal humano
   real.
5. Ativar `voice_external_enabled=true` + preencher a allowlist com o
   número de teste — só depois disso o guard deixa de bloquear.
6. Definir a política de horário permitido (hoje fail-closed, sem
   política = nunca autoriza).
7. Aplicar a migration `voice_calls` (revisão + `apply_migration` em
   ambiente controlado).
