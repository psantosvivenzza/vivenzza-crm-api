# Cria (ou substitui, se ja existir) a tarefa agendada VivenzzaSyncFinanceiroLegado.
# Precisa rodar como Administrador (Principal S4U exige elevacao neste
# Windows) - script unico, idempotente, seguro de rodar de novo quantas
# vezes for preciso.
#
# ARQUITETURA (corrigida 2026-08-19, ver watchdog-sync-financeiro.ps1 pro
# racional completo): Task Scheduler NAO aponta mais pro .bat direto.
# Aponta pro supervisor PowerShell, que por sua vez lanca e vigia o node
# --watch com deteccao propria de morte (nao depende do restart-on-failure
# do Task Scheduler, que se provou nao confiavel atras da indirecao
# .bat -> cmd.exe -> node.exe - LastTaskResult ficava em codigo anomalo
# 0xFFFFFFFF e nunca acionava o restart).
#
# CAUSA RAIZ 5 (hipotese forte, nao 100% confirmada por log fumegante):
# mesmo depois de corrigir 1-4, o supervisor continuava morrendo sozinho
# a cada poucos minutos, sem excecao/crash/deteccao de antivirus (tudo
# checado e descartado). Explicacao mais provavel: RestartCount/
# RestartInterval do Task Scheduler foi desenhado pra tarefas que
# TERMINAM, nao pra um processo residente - com o processo ainda
# "Running" quando o RestartInterval vence, o proprio Task Scheduler
# parece forcar um "reinicio". Substituido por um trigger diario (00:00)
# com repeticao a cada 5min durante 1 dia como rede de seguranca
# (MultipleInstances=IgnoreNew garante que isso nunca duplica um
# supervisor ja vivo; no dia seguinte o proprio trigger diario reinicia
# o ciclo de repeticao sozinho).
#
# CAUSA RAIZ 6 (comprovada empiricamente, 2 tentativas de instalacao
# reais): tanto -RepetitionDuration=[TimeSpan]::MaxValue (Duration fora
# do intervalo aceito, HRESULT 0x80041318) quanto -RestartCount 0 sem
# -RestartInterval (RestartOnFailure/Count vazio no XML gerado, HRESULT
# 0x80041319) mostraram que o cmdlet New-ScheduledTaskSettingsSet/
# Set-ScheduledTask traduz certas combinacoes de parametros pra XML
# ambiguo ou incompleto, mesmo com valores aparentemente corretos nos
# objetos PowerShell intermediarios (confirmado inspecionando os objetos
# antes de registrar - RestartCount=0 aparecia certinho no objeto
# Settings, mas a serializacao final pro XML da tarefa ainda incluia uma
# secao RestartOnFailure incompleta).
#
# Corrigido definitivamente: constroi a definicao INTEIRA via COM direto
# (Schedule.Service/ITaskDefinition, a mesma API que o Windows usa por
# baixo dos cmdlets) e IMPRIME o XML final gerado antes de registrar -
# nunca toca na propriedade RestartOnFailure (deixando-a intocada, o
# elemento correspondente simplesmente nao aparece no XML, comprovado
# lendo o .XmlText resultante). Registra via Register-ScheduledTask -Xml
# (aceita a string XML diretamente, sem outra camada de traducao
# ambigua) com -Force (substitui a definicao anterior se ja existir,
# mesmo comportamento idempotente de sempre).
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

$svc = New-Object -ComObject "Schedule.Service"
$svc.Connect()
$def = $svc.NewTask(0)

$def.RegistrationInfo.Description = 'Sincronizacao continua NetVision -> CRM (financeiro), vivenzza-crm-api. Task Scheduler vigia o supervisor PowerShell (watchdog-sync-financeiro.ps1), que por sua vez vigia o worker Node e reinicia sozinho se ele morrer.'

# Principal - S4U (2), sem senha gravada em lugar nenhum. RunLevel 0 =
# Limited (LUA) - mesmo padrao ja comprovado da tarefa de pedidos.
$def.Principal.UserId = $env:USERNAME
$def.Principal.LogonType = 2
$def.Principal.RunLevel = 0

# Settings - RestartOnFailure NUNCA e tocado (nem pra desligar
# explicitamente) - deixa o elemento inteiro fora do XML, unica forma
# comprovada de nao gerar Count/Interval vazio.
$def.Settings.MultipleInstances = 2   # TASK_INSTANCES_IGNORE_NEW
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries = $false
$def.Settings.AllowHardTerminate = $true
$def.Settings.StartWhenAvailable = $true
# CAUSA RAIZ 7 (comprovada empiricamente na instalacao real): "" (string
# vazia) faz o elemento <ExecutionTimeLimit> ficar OMITIDO do XML - o que
# NAO significa "sem limite" pro Windows, e sim "usa o default do schema",
# que e PT72H (72 horas)! Confirmado lendo de volta a tarefa ja registrada
# (Get-ScheduledTask mostrava ExecutionTimeLimit=PT72H mesmo com "" no XML
# de origem) - o supervisor seria morto pelo proprio Task Scheduler depois
# de 72h rodando, mesmo saudavel. O sentinela DOCUMENTADO e correto pra
# "sem limite" e a string explicita "PT0S" (zero segundos), nao a ausencia
# do elemento - corrigido, confirmado que agora o elemento aparece no XML
# com o valor certo.
$def.Settings.ExecutionTimeLimit = "PT0S"
$def.Settings.Enabled = $true
$def.Settings.Hidden = $false

# Triggers: boot + logon (inicio imediato) + diario com repeticao de
# 5min por 1 dia (rede de seguranca continua, ver CAUSA RAIZ 5/6 acima).
$triggers = $def.Triggers

$bootTrigger = $triggers.Create(8)   # TASK_TRIGGER_BOOT
$bootTrigger.Enabled = $true

$logonTrigger = $triggers.Create(9)  # TASK_TRIGGER_LOGON
$logonTrigger.UserId = $env:USERNAME
$logonTrigger.Enabled = $true

$dailyTrigger = $triggers.Create(2)  # TASK_TRIGGER_DAILY
$meiaNoite = Get-Date -Hour 0 -Minute 0 -Second 0
$dailyTrigger.StartBoundary = $meiaNoite.ToString("yyyy-MM-ddTHH:mm:ss")
$dailyTrigger.DaysInterval = 1
$dailyTrigger.Repetition.Interval = "PT5M"
$dailyTrigger.Repetition.Duration = "P1D"
$dailyTrigger.Enabled = $true

# Action - supervisor PowerShell direto, sem .bat/cmd no meio (ver CAUSA
# RAIZ 1). Sem -WindowStyle Hidden (nao ha janela pra esconder rodando
# via Task Scheduler sem sessao interativa - suspeito descartado por
# seguranca, sem custo).
$powershellExe = (Get-Command powershell.exe).Source
$argumentos = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$supervisor`""

$actions = $def.Actions
$action = $actions.Create(0)  # TASK_ACTION_EXEC
$action.Path = $powershellExe
$action.Arguments = $argumentos
$action.WorkingDirectory = $raiz

# Valida e MOSTRA o XML final antes de registrar - nunca regista as
# cegas. Se o XML nao tiver Triggers/Actions/Principals preenchidos (por
# algum erro acima), aborta sem tentar registrar nada.
$xmlFinal = $def.XmlText
Write-Output "=== XML final que sera registrado ==="
Write-Output $xmlFinal
Write-Output "======================================"

if ($xmlFinal -notmatch '<BootTrigger>' -or $xmlFinal -notmatch '<LogonTrigger>' -or $xmlFinal -notmatch '<CalendarTrigger>') {
  throw "XML final nao contem os 3 triggers esperados - abortando sem registrar."
}
if ($xmlFinal -match '<RestartOnFailure>') {
  throw "XML final contem RestartOnFailure, que nao deveria existir - abortando sem registrar."
}
if ($xmlFinal -match '<Count\s*/>|<Count>\s*</Count>|<Interval>\s*</Interval>|<Duration>\s*</Duration>') {
  throw "XML final contem um elemento obrigatorio vazio - abortando sem registrar."
}
if ($xmlFinal -notmatch '<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>') {
  throw "XML final nao tem ExecutionTimeLimit=PT0S explicito (ausente = Windows aplica default de 72h, mataria o supervisor depois de 3 dias) - abortando sem registrar."
}
if ($xmlFinal -notmatch [regex]::Escape($supervisor)) {
  throw "XML final nao referencia o caminho do supervisor esperado - abortando sem registrar."
}
Write-Output "[instalar-tarefa] validacoes basicas do XML passaram"

# Para qualquer execucao em andamento antes de trocar a definicao - senao
# uma instancia anterior (apontando pra config velha) fica orfa rodando
# em paralelo com a nova.
Stop-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $nomeTarefa -Xml $xmlFinal -Force | Out-Null
Write-Output "[instalar-tarefa] tarefa $nomeTarefa registrada via XML validado"

Enable-ScheduledTask -TaskName $nomeTarefa | Out-Null

# Limpa qualquer worker/supervisor orfao de uma execucao anterior antes
# de iniciar do zero - nunca deixa 2 instancias concorrentes durante a
# troca de arquitetura/configuracao.
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
