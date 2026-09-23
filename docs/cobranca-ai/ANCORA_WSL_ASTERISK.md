# Ancora de disponibilidade WSL2/Asterisk

## Contexto / incidente de origem

O Asterisk, o trunk NVOIP, o ARI e o servico de voz rodam dentro de uma
distro WSL2 (Ubuntu) no Windows do operador. O WSL2 encerrava a VM por
ociosidade (`vmIdleTimeout`), derrubando Asterisk/NVOIP/ARI no meio do dia
sem aviso — incidente recorrente (ver histórico em
`docs/CHATGPT_HANDOFF_2026-09-03.md` e commits relacionados a
`WSL2 idle` / `scheduler expirado`). A correcao de fundo (`.wslconfig` com
`vmIdleTimeout=-1`) evita a VM inteira desligar por ociosidade, mas **nao
resolve dois outros casos**:

1. Depois de um **reboot** do Windows, a distro WSL nao sobe sozinha — nada
   inicia o Asterisk automaticamente.
2. Se algo (Windows Update, `wsl --shutdown` manual, suspensao da maquina)
   derrubar a distro no meio do dia, ela so volta quando alguem abrir um
   terminal WSL manualmente.

A "ancora manual" ate agora era abrir um terminal e rodar
`wsl -u root -- sleep 3600` (ver `MANTER-WSL-VIVO.ps1` na raiz do repo,
nao versionado) — funciona, mas depende de alguem lembrar de fazer isso
todo dia antes da janela de cobranca (16h/17h/18h).

## O que esta ancora faz

`scripts/voice/ancora-wsl-asterisk.ps1`, registrado como tarefa agendada do
Windows (`VivenzzaAncoraWslAsteriskVoz`):

1. Acorda a distro WSL se estiver parada (comando trivial, nao mexe em
   configuracao).
2. Garante que o `systemctl` do Asterisk esta `active` dentro da distro —
   **so inicia se estiver inativo**, nunca reinicia o que ja esta rodando
   (para nao derrubar uma ligacao em andamento).
3. Registra evidencia somente-leitura em log: trunk NVOIP
   (`pjsip show registrations`), porta ARI (8088), Ollama
   (`127.0.0.1:11434`), presenca dos workers de STT/TTS
   (`scripts/voice/{tts,stt}_worker.py` etc.) e se o servico de voz do
   Windows (`run-voice-service`) esta no ar.

### O que esta ancora **nunca** faz

- Nao roda a fila de cobranca nem disca para ninguem.
- Nao amplia a allowlist nem toca em `automacoes_config`.
- Nao inicia/reinicia o servico de voz do Windows automaticamente — isso
  continua manual (`INICIAR-SERVICO-VOZ.ps1` / `npm run voice:service`),
  protegido pelo guard de codigo desatualizado existente em
  `scripts/voice/verificar-servico-voz.mjs`. Religar esse servico sozinho
  aqui poderia colocar codigo local nao revisado no ar antes de uma janela
  real de discagem — decisao deliberada de escopo, nao um esquecimento.
- Nao altera `.wslconfig` nem configuracao do Asterisk.

## Gatilhos da tarefa agendada

| Gatilho | Quando | Por que |
|---|---|---|
| No boot | +2min apos o Windows iniciar | Cobre reboot |
| No login | +1min apos o login do usuario | Cobre inicio de expediente |
| Diario | 15:45 | Rede de seguranca antes da 1a janela (16h), cobre maquina ligada ha dias sem reboot/login |

Configuracao: instancia unica (`-MultipleInstances IgnoreNew` na tarefa +
mutex nomeado dentro do proprio script), `-StartWhenAvailable` (roda assim
que possivel se o horario foi perdido, ex. notebook suspenso as 15:45),
limite de execucao de 10 minutos.

**Nota sobre o gatilho de boot**: o Windows so permite *registrar* um
gatilho `AtStartup` a partir de uma sessao PowerShell elevada
(Administrador) — isso e uma exigencia do proprio Task Scheduler, nao do
RunLevel da tarefa. Rodar o instalador sem elevacao registra a tarefa
normalmente com os gatilhos de login + horario diario, e avisa que o
gatilho de boot ficou pendente. Para adicionar boot: abrir PowerShell
como Administrador e rodar `instalar-ancora-wsl-asterisk.ps1` de novo
(idempotente — so acrescenta o gatilho que falta, nao duplica nada).

## Logs

`logs/ancora-wsl-asterisk.log` (pasta `logs/` ja esta no `.gitignore` do
repo — o log nao entra em commit). Cada execucao registra timestamp, estado
do WSL antes/depois, status do Asterisk, trunk NVOIP, porta ARI, Ollama,
presenca dos scripts de STT/TTS e status do servico de voz.

## Instalar / atualizar

```powershell
scripts\voice\instalar-ancora-wsl-asterisk.ps1
```

Idempotente — rodar de novo so atualiza a definicao da tarefa, nunca
duplica.

## Rollback

```powershell
scripts\voice\desinstalar-ancora-wsl-asterisk.ps1
```

Remove só a tarefa agendada. **Não** desliga WSL/Asterisk que já estejam
rodando (proposital — a ligação/serviço ao vivo não deve cair só porque a
âncora foi desinstalada). Para desligar a VM manualmente depois:
`wsl --shutdown`.
