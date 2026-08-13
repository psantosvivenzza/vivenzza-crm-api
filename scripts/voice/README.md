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
