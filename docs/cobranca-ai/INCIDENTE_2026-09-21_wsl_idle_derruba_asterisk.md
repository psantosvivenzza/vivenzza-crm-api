# Incidente 2026-09-21 — WSL2 derrubando o Asterisk entre ligações, gatilho do Task Scheduler expirado

## Sintoma reportado

Nenhuma ligação de cobrança desde 18/09. Bloqueios relatados: "Asterisk/NVOIP
reiniciando em loop" e Task Scheduler `VivenzzaFilaCobrancaVoz` com
`NextRunTime=N/A`.

## Contenção aplicada primeiro

Antes de qualquer diagnóstico, `voice_external_enabled` foi colocado em
`false` em `automacoes_config` (id=1) via PostgREST, como contenção
temporária. Estado confirmado antes/depois:

- Antes: `voice_external_enabled=true`, `global_daily_limit=30`,
  `global_hourly_limit=10` (inalterados).
- Depois da contenção: `voice_external_enabled=false`.

Os limites globais, allowlist e limites de voz (env vars
`VOICE_MAX_CALLS_HOUR`/`VOICE_MAX_CALLS_DAY`/`VOICE_MAX_CALLS_PER_PHONE_DAY`/
`VOICE_EXTERNAL_ALLOWLIST`, no Railway) **não foram tocados**.

## Causa 1 — Asterisk "reiniciando em loop"

Não é o Asterisk travando/crashando. Evidência do `journalctl` dentro do WSL
(Ubuntu):

```
wsl-pro-service[169]: WARNING Daemon: could not connect to Windows Agent...
systemd-logind[167]: The system will power off now!
systemd-logind[167]: System is powering down.
systemd[1]: Stopping asterisk.service ...
```

Seguido, segundos depois, de um **boot completo do kernel** ("Linux version
6.18.33.2-microsoft-standard-WSL2 ...") — ou seja, a instância WSL inteira
está sendo desligada e reiniciada, e o Asterisk cai junto como efeito
colateral (ele é `enabled` no systemd, então sobe de novo em todo boot e
cai nesse ciclo).

Confirmado que **não é**:
- cron/timer dentro do WSL (nenhum cron/timer referencia asterisk);
- outra sessão interativa concorrente (`who -a` vazio no momento do
  diagnóstico);
- processo Windows externo chamando `wsl --terminate`/`--shutdown` (scan de
  todos os processos do host não encontrou nada correspondente);
- o próprio `wsl-pro-service` (ele continua emitindo o mesmo warning de
  conexão com o agente do Ubuntu Pro — inofensivo, Ubuntu Pro nunca foi
  configurado nesta máquina — sem causar novo poweroff depois que a
  instância ficou "quente").

Causa real: **timeout de ociosidade do WSL2** — sem nenhum processo
mantendo a instância "acordada", o WSL2 desliga a VM leve poucos segundos
depois do boot, levando o Asterisk junto. Isto já era conhecido: o próprio
`MANTER-WSL-VIVO.ps1` (não versionado, na raiz do repo) foi escrito
exatamente para isso ("Mantem o WSL2 'acordado' para o Asterisk nao ser
derrubado no meio de uma ligacao"), mas depende de alguém deixar uma janela
aberta manualmente — não está automatizado, e a tarefa agendada dispara sem
ninguém presente.

### Fix estrutural proposto (ainda NÃO aplicado — pendente de autorização)

`C:\Users\msi\.wslconfig`:

```ini
[wsl2]
vmIdleTimeout=-1
```

Parâmetro oficial do WSL2 (`-1` desativa o desligamento por ociosidade).
Não existe hoje um `.wslconfig` nesta máquina — o rollback é simplesmente
apagar o arquivo (ou remover a linha) e rodar `wsl --shutdown`.

Isto é uma mudança de configuração da máquina (fora do repositório git,
não é "script versionado"), e a escrita desse arquivo foi bloqueada pelo
classificador de permissão do Claude Code como "Irreversible Local
Destruction" — precisa de autorização explícita do usuário (ou o próprio
usuário rodar via `! `).

### Mitigação temporária usada nesta sessão

Âncora manual idêntica à do `MANTER-WSL-VIVO.ps1` (`wsl -u root -- sleep
3600`) rodando em segundo plano só durante esta sessão, para permitir
validar o trunk sem chamada real. **Não é uma solução permanente** — não
sobrevive ao fim da sessão nem cobre o próximo disparo agendado às 16h.

## Causa 2 — Task Scheduler com `NextRunTime=N/A`

`VivenzzaFilaCobrancaVoz` tinha um único `TimeTrigger` com `StartBoundary`
fixo em `2026-09-18T16:00:00-03:00` e repetição horária (`PT1H`/`PT2H`) só
dentro daquele mesmo dia — ou seja, disparava 16h/17h/18h **uma única vez**,
em 18/09, e nunca mais (não era um gatilho semanal recorrente).

### Antes (backup em `VivenzzaFilaCobrancaVoz-backup-20260921-201800.xml`)

```xml
<TimeTrigger>
  <StartBoundary>2026-09-18T16:00:00-03:00</StartBoundary>
  <Repetition>
    <Interval>PT1H</Interval>
    <Duration>PT2H</Duration>
    <StopAtDurationEnd>true</StopAtDurationEnd>
  </Repetition>
</TimeTrigger>
```

### Depois

Gatilho semanal (segunda a sexta), 16h, repetindo de hora em hora por 2h
(cobre 16h/17h/18h — mesma janela e mesmo comentário de
`fila-cobranca-voz.bat`, dentro da janela legal RS 15.608/2014 até 18h40):

- `DaysOfWeek = 62` (segunda=2 + terça=4 + quarta=8 + quinta=16 + sexta=32,
  sem sábado/domingo)
- `StartBoundary` horário `16:00:00-03:00`
- `Repetition`: `Interval=PT1H`, `Duration=PT2H`, `StopAtDurationEnd=true`

Ação, diretório de trabalho e Principal (`msi`, `Interactive`) preservados
sem alteração. Tarefa foi deixada **Disabled** de propósito (só habilitar
depois do gate final). `NextRunTime` validado (habilitando/desabilitando
momentaneamente): `22/09/2026 16:00:00` — terça-feira, dia útil, dentro da
janela legal.

## O que falta para reativar

1. Autorização explícita para o fix do `.wslconfig` (ou aplicação manual
   pelo usuário) — sem isso, o Asterisk volta a cair assim que a âncora
   manual desta sessão terminar, e nada garante que ele esteja de pé às
   16h de amanhã.
2. Confirmar o trunk NVOIP registrado (`pjsip show registrations`,
   read-only) com o WSL estável.
3. Só então: `voice_external_enabled=true` de volta e
   `Enable-ScheduledTask -TaskName VivenzzaFilaCobrancaVoz`.

Enquanto o item 1 não for resolvido, `voice_external_enabled` permanece
`false` e a tarefa permanece `Disabled` — nenhuma ligação real será feita.
