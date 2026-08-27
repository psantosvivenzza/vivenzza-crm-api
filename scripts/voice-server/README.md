# Servidor de voz portátil — kit de instalação

Este diretório existe para que a infraestrutura de voz (Asterisk + ponte
STT/IA/TTS já homologada no laboratório, ver `config/asterisk/README.md` e
`scripts/voice/README.md`) possa ser reproduzida no **servidor definitivo
da empresa** com o mínimo de ações manuais — sem depender deste computador
de desenvolvimento (`DESKTOP-L0ICI4A`), deste usuário, ou de qualquer valor
específico desta máquina.

## LAB vs PRODUÇÃO

| | LAB (hoje) | VOICE SERVER PRODUÇÃO (futuro) |
|---|---|---|
| Máquina | este computador de desenvolvimento | computador dedicado, instalado na empresa |
| Uso | testes, homologação, desenvolvimento | permanentemente ligado ao celular/chip real |
| Backend CRM | continua no Railway (não muda) | continua no Railway (não muda) |
| Asterisk/gateway GSM | WSL2 + Ubuntu + Asterisk nativo | mesmo modelo (ou Linux nativo, ver abaixo) |

Nada neste kit lê o nome da máquina, usuário do SO, ou IP local para decidir
comportamento — tudo vem de `voice-server.env` (real, nunca commitado) ou é
detectado em runtime.

## Arquivos deste kit

| Arquivo | O que faz |
|---|---|
| `instalar-voice-server.ps1` | Windows: detecta WSL/Ubuntu, chama o instalador Linux, valida, registra boot automático. **Não executado nesta tarefa** — pronto para o servidor definitivo. |
| `instalar-asterisk.sh` | Linux/WSL: instala o pacote `asterisk`, aplica os templates de `config/asterisk/*.example`, cria diretórios necessários, habilita o serviço. Idempotente, nunca sobrescreve config existente sem `--force`, sempre faz backup antes. |
| `validar-voice-server.sh` | Health check somente-leitura: serviço ativo/habilitado, portas (8088 loopback, 5060/udp), config presente, endpoints PJSIP, logs recentes. |
| `backup-asterisk.sh` | Snapshot timestamped de `/etc/asterisk`, gravado fora do Git (`~/vivenzza-voice-backups` por padrão). Mantém os últimos 20. |
| `rollback-asterisk.sh` | Restaura um snapshot específico, com confirmação explícita antes de sobrescrever. |
| `voice-bridge.service.example` | Template de unit systemd para o processo Node (`voice:service`) — a outra metade do "boot automático" (Asterisk sozinho não basta; o processo que escuta o app Stasis também precisa sobreviver a reboot). |
| `preparar-bluetooth-celular.md` | Procedimento futuro (não executado agora) para parear o celular/chip real. |
| `../../config/asterisk/*.example` | Templates de config do Asterisk em si (já existiam antes desta tarefa — reaproveitados, não duplicados). Inclui o novo `mobile.conf.example` (Bluetooth/chan_mobile). |
| `../../voice-server.env.example` | Template de variáveis de ambiente do servidor de voz (raiz do repo, ao lado de `.env.example` do backend). |

## Por que Windows + WSL como caminho principal

O laboratório já roda em Windows + WSL2 Ubuntu + Asterisk nativo, homologado
com sucesso (ligação interna completa, ver `config/asterisk/README.md`). Por
isso `instalar-voice-server.ps1` é o caminho principal para o servidor
definitivo, mas ele só orquestra: toda a lógica de instalação de fato
(`instalar-asterisk.sh`, `validar-voice-server.sh`, etc.) é Linux puro e
roda igual dentro do WSL ou num Linux nativo — se o servidor final acabar
sendo Linux nativo (sem Windows), os mesmos scripts `.sh` funcionam sem
alteração, só pulando a orquestração `.ps1`.

## Inicialização automática

- **Asterisk**: o próprio pacote Debian/Ubuntu já registra uma unit systemd
  (`asterisk.service`); `instalar-asterisk.sh` roda `systemctl enable` —
  confirmado no laboratório: já está `enabled`/`active` nesta máquina hoje.
- **Ponte Node (STT/IA/TTS)**: precisa da unit própria
  (`voice-bridge.service.example`) — Asterisk sozinho reconecta, mas sem o
  processo Node também rodando, ninguém atende o app Stasis.
- **WSL em si (só quando o servidor final for Windows+WSL)**: WSL2 não
  inicia uma distro sozinho no boot do Windows.
  `instalar-voice-server.ps1 -Apply` registra uma Tarefa Agendada
  (`VivenzzaVoiceServerBoot`, gatilho "ao iniciar o sistema", executando
  como SYSTEM) que só dispara `wsl.exe -d <distro> -e true` — suficiente
  para a VM subir; a partir daí o systemd interno (systemd=true em
  `/etc/wsl.conf`, já confirmado presente no laboratório) cuida do resto.
- Cobre boot, restart do processo (`Restart=on-failure` na unit Node,
  `RestartCount`/`RestartInterval` na Tarefa Agendada) e crash — validado
  via `validar-voice-server.sh` sempre no fim de qualquer instalação.

## Integração CRM ↔ servidor de voz (avaliação, nada ativado)

Hoje o backend usa **ARI** (`AsteriskTelephonyProvider`, `POST /channels`),
nunca AMI nem webhook — ver `src/lib/collection/telephony/asteriskTelephonyProvider.js`.
O ARI do Asterisk só escuta em loopback (127.0.0.1:8088), nunca exposto —
correto para o laboratório, onde CRM e Asterisk estão na mesma máquina.

No servidor definitivo, Railway (nuvem) e o Asterisk (rede da empresa) são
máquinas **diferentes** — expor ARI diretamente à internet sem proteção é
inaceitável (CRÍTICO, conforme pedido). Nenhum mecanismo de comunicação
externa foi implementado ou ativado nesta tarefa. Recomendação para quando
isso for decidido: um túnel/VPN ponto-a-ponto (ex.: WireGuard ou Tailscale)
entre o Railway e o servidor de voz, nunca abrir a porta ARI publicamente —
`voice-server.env.example` já reserva `VOICE_SERVER_TUNNEL_MODE`/
`VOICE_SERVER_TUNNEL_ENDPOINT` como placeholder para essa decisão futura.

## Flags de segurança — sempre FALSE até autorização explícita

`VOICE_EXTERNAL_ENABLED`/`TRUNK_EXTERNO_CONFIGURADO` (aplicação,
`src/lib/collection/featureFlags.js`/`src/lib/voice/destinoResolver.js`)
continuam `false` mesmo depois de todo este kit instalado no servidor
definitivo — a simples presença do Asterisk/gateway não libera chamada
externa por si só. Nenhum script deste kit toca essas flags.

## Procedimento esperado no servidor definitivo

1. Clonar o repositório.
2. Copiar `voice-server.env.example` para `voice-server.env` e preencher os
   valores reais da máquina (sem sudo/root necessário para isto).
3. `powershell -File scripts\voice-server\instalar-voice-server.ps1 -Apply`
   — **1 comando administrador**, prepara WSL/Ubuntu/Asterisk, aplica
   config, habilita boot automático, valida.
4. Seguir `preparar-bluetooth-celular.md` para conectar/parear o
   celular/chip real (procedimento manual por natureza — pareamento
   Bluetooth não é automatizável com segurança).
5. Copiar/preencher `voice-bridge.service.example` e habilitar
   (`systemctl enable --now vivenzza-voice-bridge`).
6. `scripts/voice-server/validar-voice-server.sh` — confirmar tudo verde.
7. Testar chamada **interna** (ramal 7001, já homologado) para validar
   ponta a ponta na máquina nova.
8. **Somente com autorização posterior explícita**: decidir trunk SIP
   externo, ativar `VOICE_EXTERNAL_ENABLED`/`TRUNK_EXTERNO_CONFIGURADO`,
   configurar túnel/VPN para o Railway.

Isso substitui as dezenas de comandos manuais executados neste laboratório
por: **1 arquivo de env preenchido + 1 comando administrador + 1
pareamento Bluetooth manual + 1 serviço systemd habilitado** — os únicos
passos que genuinamente não dá para automatizar com segurança (segredos e
pareamento físico).
