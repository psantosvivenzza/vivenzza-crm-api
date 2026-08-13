# Voice AI MVP — setup local do Asterisk

Este diretório tem os arquivos de configuração de EXEMPLO (`.example`, sem
segredos) para rodar um Asterisk local mínimo, só pra ligação interna de
teste (ramal 7001 → 8001 → IA). Nada aqui expõe o Asterisk publicamente,
nada configura trunk PSTN/SIP externo.

**Status: homologado com sucesso em ambiente WSL2 + Asterisk 22.5.2 —
StasisStart → answer → captura de fala → STT → IA (mesmo cérebro do
WhatsApp) → TTS → playback → 2 turnos completos ouvidos de verdade pelo
operador, canal encerrado por hangup() explícito do próprio serviço.**

## Setup usado na homologação (WSL2 + Ubuntu + Asterisk nativo, não Docker)

1. `wsl --install` (PowerShell administrador) + reboot.
2. `sudo apt update && sudo apt install -y asterisk`.
3. Copiar os arquivos `.example` deste diretório para os caminhos reais
   (`/etc/asterisk/pjsip.conf`, `extensions.conf`, `ari.conf`, `http.conf`),
   gerando senha própria (nunca reusar o placeholder).
4. `sudo systemctl restart asterisk` (ou `core reload` via CLI depois de
   mudar config).

## ACHADO CRÍTICO — diretório real de sons "custom"

`ASTERISK_SOUNDS_DIR` **NÃO é** `/var/lib/asterisk/sounds/custom` (esse
caminho existe, é gravável, mas o Asterisk NUNCA procura arquivos lá para
`sound:custom/...`). O Asterisk resolve `sound:custom/X` relativo a
`astdatadir` (`/usr/share/asterisk`, não `astvarlibdir`), e
`/usr/share/asterisk/sounds/custom` é um **symlink**:

```
/usr/share/asterisk/sounds/custom -> ../../../local/share/asterisk/sounds
```

Ou seja, o destino REAL onde gravar os `.wav`/`.ulaw` gerados pela IA é:

```
ASTERISK_SOUNDS_DIR=/usr/local/share/asterisk/sounds
```

(a URI `sound:custom/X` continua sendo usada no código — ela resolve
corretamente pelo symlink, só o caminho de ESCRITA precisava apontar pro
alvo real). Escrever no lugar errado produz exatamente este sintoma
enganoso: nenhum erro de permissão, arquivo existe no disco, mas o
Asterisk loga `File custom/X does not exist in any format` — porque ele
está procurando num diretório completamente diferente.

## ACHADO — formato de áudio

O parser de WAV do Asterisk é restrito e rejeitava a saída do Piper mesmo
em PCM 8kHz/16-bit/mono válido (mesmo sintoma: "does not exist in any
format"). Fix: `tts_synthesize.py` grava também uma cópia `.ulaw` bruta
(G.711 mu-law, sem container) ao lado do `.wav` — o Asterisk sempre
reconhece `.ulaw` nativamente.

## ACHADO — latência

`PlaybackFinished`/`RecordingFinished` via WebSocket ARI eram pouco
confiáveis neste ambiente (nem sempre chegavam a tempo). O serviço usa a
duração conhecida do áudio gerado como cronômetro determinístico em vez de
depender só do evento. Uma frase de feedback curta ("Só um instante
enquanto verifico isso.") toca imediatamente após a captura, sem esperar
STT/LLM/TTS — o processamento real roda "por baixo" dela.

## Env locais necessárias (nunca commitadas)

- `ARI_URL` (ex: `http://127.0.0.1:8088`)
- `ARI_USER` / `ARI_PASSWORD` (as mesmas de `ari.conf`)
- `ARI_APP=vivenzza-voice-ai`
- `ASTERISK_SOUNDS_DIR=/usr/local/share/asterisk/sounds` (ver achado acima)
- `ASTERISK_RECORDINGS_DIR=/var/spool/asterisk/recording` (criar com
  `sudo mkdir -p` se não existir — não vem criado por padrão)
- `VOICE_PYTHON_BIN`, `VOICE_STT_SCRIPT_PATH`, `VOICE_TTS_SCRIPT_PATH`,
  `VOICE_TTS_MODEL_PATH` (ver scripts/voice/README.md)

## Fluxo

1. `npm run voice:service` — pré-gera saudação + feedback, aquece o Ollama.
2. Registrar um softphone (ex: MicroSIP) no ramal `7001`.
3. Discar `8001`.
4. Ouvir a saudação, falar depois do bipe, ouvir a resposta da IA — até
   `VOICE_MAX_TURNOS` turnos, ou até `requires_human=true`.
