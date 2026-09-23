# Registra (ou atualiza, se ja existir) a tarefa agendada da ancora
# WSL/Asterisk. Idempotente: rodar de novo so atualiza a definicao, nunca
# duplica a tarefa. Ve docs/cobranca-ai/ANCORA_WSL_ASTERISK.md.
#
# Para reverter: scripts/voice/desinstalar-ancora-wsl-asterisk.ps1

$ErrorActionPreference = 'Stop'

$TaskName = 'VivenzzaAncoraWslAsteriskVoz'
$ScriptPath = Join-Path $PSScriptRoot 'ancora-wsl-asterisk.ps1'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$LogDir = Join-Path $RepoRoot 'logs'

if (-not (Test-Path $ScriptPath)) {
    throw "Script da ancora nao encontrado em: $ScriptPath"
}
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$existente = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existente) {
    Write-Host "Tarefa '$TaskName' ja existe (estado atual: $($existente.State)) — atualizando definicao em vez de duplicar." -ForegroundColor Yellow
} else {
    Write-Host "Criando tarefa '$TaskName'..." -ForegroundColor Cyan
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""

# O gatilho "no boot" (AtStartup) so pode ser REGISTRADO a partir de uma
# sessao elevada (Administrador) — isso e exigencia do proprio Task
# Scheduler do Windows, nao depende do RunLevel da tarefa em si. Se esta
# sessao nao estiver elevada, o instalador segue em frente sem esse
# gatilho (login + horario diario ja cobrem o dia a dia) e avisa como
# completar depois. Rodar este instalador de novo, ja elevado, e
# suficiente para adicionar o gatilho de boot (idempotente).
$isElevado = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

$triggers = @()
if ($isElevado) {
    $triggerBoot = New-ScheduledTaskTrigger -AtStartup
    $triggerBoot.Delay = 'PT2M'
    $triggers += $triggerBoot
} else {
    Write-Host "AVISO: sessao nao elevada — o gatilho 'no boot' (AtStartup) exige Administrador e foi PULADO nesta instalacao." -ForegroundColor Yellow
    Write-Host "  Para cobrir tambem o boot: abra PowerShell como Administrador e rode este instalador de novo (e idempotente, so adiciona o gatilho que falta)." -ForegroundColor Yellow
}

# Gatilho: no login do usuario atual (com atraso de 1 min).
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$triggerLogon.Delay = 'PT1M'
$triggers += $triggerLogon

# Gatilho: todo dia as 15:45, antes da primeira janela de discagem (16h).
# Cobre o caso de a maquina ficar ligada varios dias sem reboot/login.
$triggerPreJanela = New-ScheduledTaskTrigger -Daily -At '15:45'
$triggers += $triggerPreJanela

# RunLevel Limited (nao Highest) de proposito: nada no script da ancora
# precisa de elevacao do Windows — o systemctl roda como root DENTRO do
# WSL, que e um contexto de privilegio totalmente independente do Windows.
# RunLevel Highest exigiria registrar a tarefa a partir de uma sessao
# PowerShell ja elevada (Executar como administrador), o que nao e o caso
# do operador no dia a dia.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)

try {
    Register-ScheduledTask -TaskName $TaskName `
        -Action $action `
        -Trigger $triggers `
        -Principal $principal `
        -Settings $settings `
        -Description 'Vivenzza: mantem WSL2/Asterisk (e verifica NVOIP/ARI/Ollama/STT/TTS/servico de voz) disponiveis antes da janela de cobranca por voz (16h-18h). NAO executa fila, NAO disca, NAO altera allowlist. Rollback: scripts/voice/desinstalar-ancora-wsl-asterisk.ps1' `
        -Force -ErrorAction Stop | Out-Null
} catch {
    Write-Host "FALHA ao registrar a tarefa '$TaskName': $($_.Exception.Message)" -ForegroundColor Red
    throw
}

$confirmada = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $confirmada) {
    throw "Register-ScheduledTask nao lancou erro, mas a tarefa '$TaskName' nao aparece em Get-ScheduledTask. Aborting."
}

Write-Host "Tarefa '$TaskName' registrada/atualizada com sucesso ($($triggers.Count) gatilho(s))." -ForegroundColor Green
$confirmada | Select-Object TaskName, State | Format-Table -AutoSize
$confirmada.Triggers | Format-Table -AutoSize
if (-not $isElevado) {
    Write-Host "Cobertura atual: login + diario as 15:45. Gatilho de boot ainda PENDENTE (rode como Administrador para completar)." -ForegroundColor Yellow
}
