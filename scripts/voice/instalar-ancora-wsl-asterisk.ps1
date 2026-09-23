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

# Gatilho 1: no boot (com atraso de 2 min pra WSL Service/rede assentarem).
$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerBoot.Delay = 'PT2M'

# Gatilho 2: no login do usuario atual (com atraso de 1 min).
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$triggerLogon.Delay = 'PT1M'

# Gatilho 3: todo dia as 15:45, antes da primeira janela de discagem (16h).
# Cobre o caso de a maquina ficar ligada varios dias sem reboot/login.
$triggerPreJanela = New-ScheduledTaskTrigger -Daily -At '15:45'

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName $TaskName `
    -Action $action `
    -Trigger @($triggerBoot, $triggerLogon, $triggerPreJanela) `
    -Principal $principal `
    -Settings $settings `
    -Description 'Vivenzza: mantem WSL2/Asterisk (e verifica NVOIP/ARI/Ollama/STT/TTS/servico de voz) disponiveis antes da janela de cobranca por voz (16h-18h). NAO executa fila, NAO disca, NAO altera allowlist. Rollback: scripts/voice/desinstalar-ancora-wsl-asterisk.ps1' `
    -Force | Out-Null

Write-Host "Tarefa '$TaskName' registrada/atualizada com sucesso." -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State | Format-Table -AutoSize
(Get-ScheduledTask -TaskName $TaskName).Triggers | Format-Table -AutoSize
