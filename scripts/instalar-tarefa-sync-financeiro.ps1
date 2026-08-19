# Cria (ou corrige, se ja existir) a tarefa agendada VivenzzaSyncFinanceiroLegado.
# Precisa rodar como Administrador (Register-ScheduledTask/Set-ScheduledTask
# com Principal S4U exigem elevacao neste Windows) - script unico,
# idempotente, seguro de rodar de novo quantas vezes for preciso.
#
# ARQUITETURA (corrigida 2026-08-19, ver watchdog-sync-financeiro.ps1 pro
# racional completo): Task Scheduler NAO aponta mais pro .bat direto.
# Aponta pro supervisor PowerShell, que por sua vez lanca e vigia o node
# --watch com deteccao propria de morte (nao depende do restart-on-failure
# do Task Scheduler, que se provou nao confiavel atras da indirecao
# .bat -> cmd.exe -> node.exe - LastTaskResult ficava em codigo anomalo
# 0xFFFFFFFF e nunca acionava o restart).
#
# CAUSA RAIZ 5 (comprovada empiricamente, mesmo dia, apos corrigir 1-4): o
# proprio supervisor (ja rodando powershell.exe direto, sem .bat, com log
# proprio e try/catch amplo) continuava morrendo sozinho a cada poucos
# minutos, SEM excecao capturada, SEM evento de crash (Application/
# PowerShell event log limpos), SEM deteccao do Windows Defender (checado
# e confirmado limpo). A explicacao mais provavel: RestartCount/
# RestartInterval do Task Scheduler foi desenhado pra tarefas que TERMINAM
# (sucesso ou falha) e voce quer retentar - nao pra um processo residente
# que roda pra sempre de proposito. Com o processo ainda "Running" quando
# o RestartInterval vence, o proprio Task Scheduler parece forcar o
# encerramento pra "reiniciar" - o oposto do que queremos aqui. Corrigido:
# RestartCount=0 (Task Scheduler nao tenta mais "ajudar" reiniciando um
# processo que nunca deveria terminar sozinho) - a recuperacao de verdade
# fica 100% por conta do loop interno do supervisor (que so ele sabe
# distinguir "o worker morreu de verdade" de "ainda estou rodando
# normalmente"). Tambem removido -WindowStyle Hidden (nao faz sentido
# nem tem janela pra esconder rodando via Task Scheduler sem sessao
# interativa - suspeito adicional descartado por seguranca, sem custo).
#
# Rede de seguranca substituta: alem de AtLogOn/AtStartup, um trigger
# DIARIO (00:00) com repeticao a cada 5min DURANTE 1 dia
# (Duration=P1D - valor valido, dentro do limite aceito pelo Windows;
# a 1a tentativa usou RepetitionDuration=[TimeSpan]::MaxValue pra
# "repetir pra sempre", o que gera P99999999DT23H59M59S no XML da tarefa -
# fora do intervalo aceito pelo Task Scheduler, HRESULT 0x80041318,
# Set-ScheduledTask falhou e a tarefa NAO foi atualizada). Com Duration=P1D
# a repeticao de 5min cobre o dia inteiro; no dia seguinte o proprio
# trigger diario (00:00) reinicia o ciclo de repeticao sozinho - padrao
# oficialmente suportado, sem duracao artificial/infinita.
#
# New-ScheduledTaskTrigger -Daily nao aceita -RepetitionInterval/
# -RepetitionDuration diretamente (limitacao conhecida do cmdlet, testada
# e confirmada aqui) - contorno padrao: cria um trigger -Once soh pra
# gerar o objeto Repetition corretamente preenchido, copia pro trigger
# diario de verdade.
#
# Com MultipleInstances=IgnoreNew, se o supervisor ja estiver rodando
# cada tick e um no-op (Task Scheduler ignora a tentativa) - mas se ele
# tiver morrido por qualquer motivo, o proximo tick (no maximo 5min
# depois) traz ele de volta sozinho, sem depender do mecanismo de
# restart-on-failure (RestartCount/RestartInterval), que a evidencia
# disponivel (nenhum evento de termino/erro no log do Task Scheduler pras
# geracoes que morreram sozinhas, quando toda outra causa possivel foi
# descartada - excecao .NET, crash, Windows Defender) aponta como a causa
# mais provavel de mortes periodicas nao explicadas do supervisor. Isto
# e uma HIPOTESE forte, nao um fato 100% confirmado por um log
# fumegante - mas desligar RestartCount pra um processo residente e uma
# mudanca correta e segura de qualquer forma (o loop interno do
# supervisor + este heartbeat cobrem a mesma necessidade de forma mais
# previsivel e observavel).
#
# So mexe na tarefa VivenzzaSyncFinanceiroLegado. Nunca toca em
# VivenzzaSyncPedidosLegado.
$ErrorActionPreference = 'Stop'
$nomeTarefa = 'VivenzzaSyncFinanceiroLegado'
$raiz = Split-Path -Parent $PSScriptRoot
$supervisor = Join-Path $raiz 'scripts\watchdog-sync-financeiro.ps1'

if (-not (Test-Path $supervisor)) {
  throw "Nao encontrei $supervisor - rode este script a partir do checkout do vivenzza-crm-api."
}

$powershellExe = (Get-Command powershell.exe).Source
$argumentos = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$supervisor`""
$action = New-ScheduledTaskAction -Execute $powershellExe -Argument $argumentos -WorkingDirectory $raiz

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerHeartbeat = New-ScheduledTaskTrigger -Daily -At "00:00"
$repeticaoTemplate = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 1)
$triggerHeartbeat.Repetition = $repeticaoTemplate.Repetition

$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 0 `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

$existe = Get-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue
if ($existe) {
  # Para qualquer execucao em andamento antes de trocar a definicao -
  # senao a instancia antiga (apontando pro .bat velho) fica orfa rodando
  # em paralelo com a nova.
  Stop-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue
  Set-ScheduledTask -TaskName $nomeTarefa -Action $action -Trigger @($triggerLogon, $triggerBoot, $triggerHeartbeat) -Settings $settings -Principal $principal | Out-Null
  Write-Output "[instalar-tarefa] tarefa $nomeTarefa ja existia - definicao corrigida (agora aponta pro supervisor)"
} else {
  $definicao = New-ScheduledTask -Action $action -Trigger @($triggerLogon, $triggerBoot, $triggerHeartbeat) -Settings $settings -Principal $principal `
    -Description 'Sincronizacao continua NetVision -> CRM (financeiro), vivenzza-crm-api. Task Scheduler vigia o supervisor PowerShell (watchdog-sync-financeiro.ps1), que por sua vez vigia o worker Node e reinicia sozinho se ele morrer.'
  Register-ScheduledTask -TaskName $nomeTarefa -InputObject $definicao | Out-Null
  Write-Output "[instalar-tarefa] tarefa $nomeTarefa criada"
}

Enable-ScheduledTask -TaskName $nomeTarefa | Out-Null

# Limpa qualquer worker/supervisor orfao de uma execucao anterior antes de
# iniciar do zero - nunca deixa 2 instancias concorrentes durante a troca
# de arquitetura (.bat antigo -> supervisor novo).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'sync-financeiro-legado\.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'watchdog-sync-financeiro\.ps1' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$logDir = Join-Path $raiz 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stopFlag = Join-Path $logDir 'sync-financeiro.stop'
if (Test-Path $stopFlag) { Remove-Item $stopFlag -Force }

Start-ScheduledTask -TaskName $nomeTarefa
Start-Sleep -Seconds 3
$info = Get-ScheduledTaskInfo -TaskName $nomeTarefa
$estado = (Get-ScheduledTask -TaskName $nomeTarefa).State
Write-Output "[instalar-tarefa] tarefa iniciada - estado: $estado, ultimo resultado: $($info.LastTaskResult)"
Write-Output "[instalar-tarefa] concluido"
