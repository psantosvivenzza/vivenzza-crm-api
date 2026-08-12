# Voice AI MVP — setup local do Asterisk

Este diretório tem os arquivos de configuração de EXEMPLO (`.example`, sem
segredos) para rodar um Asterisk local mínimo, só pra ligação interna de
teste (ramal 7001 → 8001 → IA). Nada aqui expõe o Asterisk publicamente,
nada configura trunk PSTN/SIP externo.

## Bloqueio atual (ação humana necessária)

Nesta sessão, nem **WSL2** nem **Docker Desktop** estavam disponíveis na
máquina — e o Asterisk é um daemon Linux, não roda nativamente no Windows.
Sem um desses dois, não é possível rodar o Asterisk e portanto não é
possível originar uma ligação real.

**Para desbloquear, escolha UMA das opções abaixo (ação manual, fora do
Claude Code):**

### Opção A — WSL2 (recomendado)
1. Abrir PowerShell **como administrador**.
2. Rodar: `wsl --install`
3. Reiniciar o computador quando solicitado.
4. Depois do reboot, abrir o Ubuntu (ou a distro instalada) e rodar:
   ```
   sudo apt update && sudo apt install -y asterisk
   ```
5. Copiar os arquivos `.example` deste diretório para os caminhos reais do
   Asterisk (tipicamente `/etc/asterisk/pjsip.conf`,
   `/etc/asterisk/extensions.conf`, `/etc/asterisk/ari.conf`,
   `/etc/asterisk/http.conf`), gerando suas próprias senhas.
6. `sudo systemctl restart asterisk`

### Opção B — Docker Desktop
1. Instalar o Docker Desktop for Windows (usa WSL2 por baixo, mas o
   instalador cuida disso automaticamente na maioria dos casos).
2. Rodar um container Asterisk (ex: `andrius/asterisk` ou equivalente),
   montando os arquivos deste diretório como config.

## Depois do Asterisk rodando

1. Configurar as env locais (nunca commitadas — ver `.env.voice.example` na
   raiz do backend):
   - `ARI_URL` (ex: `http://127.0.0.1:8088`)
   - `ARI_USER` / `ARI_PASSWORD` (as mesmas de `ari.conf`)
   - `ARI_APP=vivenzza-voice-ai`
   - `ASTERISK_SOUNDS_DIR` (ex: `/var/lib/asterisk/sounds/custom`)
   - `ASTERISK_RECORDINGS_DIR` (ex: `/var/spool/asterisk/recording`)
   - `VOICE_PYTHON_BIN`, `VOICE_STT_SCRIPT_PATH`, `VOICE_TTS_SCRIPT_PATH`,
     `VOICE_TTS_MODEL_PATH` (ver scripts/voice/README.md)
2. `npm run voice:service`
3. Registrar um softphone (ex: Zoiper, Linphone) no ramal `7001` (usuário
   `voice-test-7001`, senha que você gerou) apontando pro Asterisk local.
4. Discar `8001` a partir do softphone.
5. Ouvir a saudação e conversar com a IA por até `VOICE_MAX_TURNOS` turnos.

## O que NÃO foi testado nesta sessão

A integração ARI em si (`src/lib/voice/ariCallService.js`) nunca rodou
contra um Asterisk real — está escrita seguindo os padrões documentados da
API ARI, mas não homologada. As peças de STT/cérebro/TTS que ela orquestra
FORAM testadas de ponta a ponta fora do contexto de chamada telefônica (ver
`scripts/voice/README.md`).
