<#
    Configura a tarefa agendada VivenzzaSyncPedidosLegado no Windows Task
    Scheduler, pra rodar scripts\sync-pedidos-legado.mjs automaticamente.

    O e01 (NetVision/ES_Pedidos) so e alcancavel a partir da rede local do
    DESKTOP-Q6O54R1 - por isso essa sincronizacao nao pode rodar no Railway
    e precisa de uma tarefa agendada local, no mesmo padrao ja usado pela
    tarefa VivenzzaSyncEstoqueE01.

    Uso: rode este script NA MAQUINA com acesso ao e01 (ou na mesma rede),
    com PowerShell como Administrador - Register-ScheduledTask exige elevacao.

        powershell -ExecutionPolicy Bypass -File .\scripts\setup-sync-pedidos.ps1

    Repetivel: se a tarefa ja existir, ela e removida e recriada com a
    configuracao atual deste script.
#>

$ErrorActionPreference = 'Stop'

$TaskName = 'VivenzzaSyncPedidosLegado'
$RepoPath = Split-Path -Parent $PSScriptRoot   # .../vivenzza-crm-api
$LogDir   = Join-Path $RepoPath 'logs'
$BatPath  = Join-Path $RepoPath 'sync-pedidos.bat'
$LogPath  = Join-Path $LogDir 'sync-pedidos.log'

Write-Host "Repositorio detectado: $RepoPath"

# 1. Garante a pasta de logs
if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    Write-Host "Pasta de logs criada: $LogDir"
}

# 2. Localiza o node.exe (precisa estar no PATH da maquina)
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "node.exe nao encontrado no PATH. Instale o Node.js (ou ajuste o PATH do sistema) antes de continuar."
    exit 1
}
$NodePath = $NodeCmd.Source
Write-Host "node.exe encontrado em: $NodePath"

# 3. Gera o .bat wrapper - mesmo padrao do sync-estoque.bat ja existente:
#    entra na pasta do repositorio e redireciona stdout/stderr pro log.
#    Um .bat e usado (em vez de chamar node.exe direto na Scheduled Task
#    Action) porque a Action nao faz redirecionamento de shell sozinha.
$BatContent = @"
@echo off
cd /d "%~dp0"
"$NodePath" scripts\sync-pedidos-legado.mjs >> logs\sync-pedidos.log 2>&1
"@
Set-Content -Path $BatPath -Value $BatContent -Encoding ASCII
Write-Host "Wrapper criado/atualizado: $BatPath"

# 4. Trigger: seg-sex, a cada 30 min, das 08h00 as 18h00.
#    -Weekly nao aceita -RepetitionInterval/-RepetitionDuration diretamente
#    nesta versao do modulo ScheduledTasks - o padrao pra contornar isso e
#    montar a repeticao num trigger -Once descartavel e enxertar no -Weekly.
$RepeticaoBase = New-ScheduledTaskTrigger -Once -At 08:00 `
    -RepetitionInterval (New-TimeSpan -Minutes 30) `
    -RepetitionDuration (New-TimeSpan -Hours 10)
$Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday, Tuesday, Wednesday, Thursday, Friday -At 08:00
$Trigger.Repetition = $RepeticaoBase.Repetition

# 5. Action: roda o .bat wrapper com a pasta do repositorio como diretorio de trabalho
$Action = New-ScheduledTaskAction -Execute $BatPath -WorkingDirectory $RepoPath

# 6. Principal: mesmo usuario atual, roda mesmo sem estar com a sessao aberta,
#    sem precisar guardar senha (S4U) - mesmo padrao ja usado na tarefa de estoque.
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited

# 7. Settings: nao trava se cair a rede por um instante, nao empilha execucoes
#    concorrentes se uma rodada atrasar, mata a tarefa se travar (protecao -
#    a sincronizacao incremental normal leva segundos; um backfill grande leva
#    poucos minutos, nunca deveria bater 25 min).
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 25)

# 8. Remove versao anterior da tarefa, se existir, e registra a nova
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Write-Host "Tarefa '$TaskName' ja existe - removendo pra recriar com a configuracao atual."
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName `
    -Trigger $Trigger -Action $Action -Principal $Principal -Settings $Settings `
    -Description "Sincronizacao incremental de pedidos com o legado (e01/ES_Pedidos) - vivenzza-crm-api. Seg-sex, a cada 30 min, 08h-18h." `
    | Out-Null

Write-Host ""
Write-Host "Tarefa '$TaskName' criada com sucesso."
Write-Host "Script:      $RepoPath\scripts\sync-pedidos-legado.mjs"
Write-Host "Wrapper:     $BatPath"
Write-Host "Log:         $LogPath"
Write-Host "Frequencia:  seg-sex, a cada 30 min, 08h00-18h00"
Write-Host ""
Write-Host "Rodar manualmente agora (pra conferir):  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Ver o historico da ultima execucao:       Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "Acompanhar o log em tempo real:            Get-Content '$LogPath' -Wait -Tail 20"
