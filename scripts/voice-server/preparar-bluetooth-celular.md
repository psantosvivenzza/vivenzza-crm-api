# Bluetooth/celular — procedimento futuro (não executado nesta tarefa)

Camada PLUGÁVEL: nenhum aparelho específico é configurado agora. Isto é o
roteiro para quando o servidor definitivo da empresa e o celular/chip
dedicado existirem fisicamente.

## Passo a passo

1. **Conectar um dongle Bluetooth dedicado**, se o servidor não tiver
   Bluetooth embutido (recomendado num servidor fixo — evita depender do
   Bluetooth onboard de um desktop genérico).
2. **Expor o dispositivo ao Linux/WSL.**
   - Linux nativo: funciona direto (`hciconfig`/`bluetoothctl`).
   - WSL2: Bluetooth USB não é repassado automaticamente — precisa de
     `usbipd-win` (Windows) + `usbip attach` (dentro do WSL) para o dongle
     aparecer como dispositivo USB dentro da distro. Validar isso
     especificamente no servidor definitivo antes de prosseguir — pode ser
     motivo suficiente para preferir Linux nativo nessa máquina em vez de
     WSL, se o repasse USB Bluetooth se mostrar instável.
3. **Parear o celular da empresa**:
   ```
   bluetoothctl
   power on
   agent on
   scan on
   pair <MAC_DO_CELULAR>
   trust <MAC_DO_CELULAR>
   connect <MAC_DO_CELULAR>
   ```
4. **Descobrir o endereço real do aparelho** (`<MAC_DO_CELULAR>` acima,
   `hciconfig` para o endereço do adapter local).
5. **Preencher a configuração LOCAL segura** — `voice-server.env` (real,
   fora do Git) com `VOICE_MOBILE_ADAPTER`/`VOICE_MOBILE_DEVICE`, e
   `/etc/asterisk/mobile.conf` (real, gerado a partir de
   `config/asterisk/mobile.conf.example` pelo instalador) com os mesmos
   valores.
6. **Carregar o `chan_mobile`** (`module load chan_mobile.so` via
   `asterisk -rx`, ou reload completo) e confirmar no `modules.conf` que
   ele não está em `noload`.
7. **Validar o registro** — `asterisk -rx "mobile show devices"` deve
   mostrar o aparelho `Connected`, não só `Paired`.
8. **Só depois** liberar chamadas de fato pelo canal mobile — e mesmo
   assim, `VOICE_EXTERNAL_ENABLED`/`TRUNK_EXTERNO_CONFIGURADO` continuam
   `false` até uma autorização explícita e específica para chamada externa
   real (este procedimento sozinho não muda nenhuma das duas flags).

## O que NUNCA fazer

- Nunca commitar `<MAC_DO_CELULAR>`, PIN de pareamento, ou qualquer
  identificador do aparelho real em `config/asterisk/mobile.conf.example`
  ou em qualquer arquivo rastreado pelo Git — só em `voice-server.env`
  (real) e `/etc/asterisk/mobile.conf` (real), ambos fora do repositório.
- Nunca reautenticar o pareamento via config a cada boot — parear uma vez,
  marcar `trust`, deixar o SO reconectar sozinho.
