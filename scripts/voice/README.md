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

## O que NÃO foi testado

A chamada telefônica real (Asterisk + PJSIP + ARI) — sem WSL2/Docker
disponíveis nesta máquina nesta sessão, não havia como rodar o Asterisk.
Ver `config/asterisk/README.md` para a ação manual necessária.

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
