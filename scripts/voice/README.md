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

## Env necessárias (nunca commitadas)

```
VOICE_PYTHON_BIN=python
VOICE_STT_SCRIPT_PATH=<caminho absoluto para stt_transcribe.py>
VOICE_STT_MODEL=small
VOICE_TTS_SCRIPT_PATH=<caminho absoluto para tts_synthesize.py>
VOICE_TTS_MODEL_PATH=<caminho absoluto para o .onnx do Piper>
```
