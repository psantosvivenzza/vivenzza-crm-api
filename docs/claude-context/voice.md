# Voz / IA por telefone

## Laboratório atual (máquina de desenvolvimento)

- Asterisk 22.5.2, WSL2 + Ubuntu.
- ARI (Asterisk REST Interface) só em loopback — nunca exposto na rede.
- Ramal interno homologado: `7001` → `8001` → app Stasis.
- Fluxo completo já homologado com sucesso: ligação interna → saudação →
  captura de fala → STT (faster-whisper) → IA (mesmo cérebro do WhatsApp,
  Ollama `qwen2.5:7b-instruct`) → TTS (Piper, voz `pt_BR-jeff-medium`) →
  playback → 2 turnos completos → encerramento limpo.
- Integração com o backend: **ARI**, nunca AMI/webhook
  (`AsteriskTelephonyProvider`, `src/lib/collection/telephony/`).

## Segurança — flags que nunca devem virar `true` sem autorização explícita

- `voice_external_enabled=false`
- `TRUNK_EXTERNO_CONFIGURADO=false`
- Nenhuma chamada PSTN real ativa hoje. A simples presença de
  Asterisk/gateway não pode, por si só, permitir ligação externa — as
  flags são checadas independentemente disso.

## Kit portátil (PR #56, mergeada)

- `scripts/voice-server/` — instalador idempotente (Linux/WSL +
  orquestrador Windows), backup/rollback de `/etc/asterisk`, health check,
  boot automático (systemd + Tarefa Agendada), tudo sem hardcode desta
  máquina (nome do host, usuário, IP, MAC).
- Preparado para o **servidor definitivo da empresa** — nenhuma instalação
  real foi feita fora do laboratório ainda.

## Pendente antes de qualquer chamada externa real

- Escolher o hardware definitivo do servidor.
- Celular/chip da empresa — **preferir um plano/número já existente**
  (custo adicional zero), evitar contratar linha nova só para isso quando
  não for necessário.
- Bluetooth/dongle dedicado, se o servidor definitivo não tiver Bluetooth
  onboard confiável.
- Decidir mecanismo de túnel/VPN entre o Railway (nuvem) e o servidor de
  voz (rede da empresa) — **nunca expor ARI diretamente à internet**, essa
  é a exigência crítica não negociável de qualquer desenho de conectividade.
- Só depois de tudo isso validado internamente: decidir trunk SIP externo
  e ativar as flags acima, com autorização explícita e específica.
