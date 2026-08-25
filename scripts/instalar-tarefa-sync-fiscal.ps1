# Cria (ou substitui, se ja existir) a tarefa agendada VivenzzaSyncFiscalLegado.
# Precisa rodar como Administrador (Principal S4U exige elevacao neste
# Windows) - script unico, idempotente, seguro de rodar de novo quantas
# vezes for preciso.
#
# ARQUITETURA (deliberadamente DIFERENTE do sync financeiro/PR #50): o script
# scripts/sync-vendas-fiscais-legado.mjs e de tiro unico (roda, upserta em
# notas_fiscais_netvision via legacy_nfe_id, sai) - nao tem --watch, nao e um
# processo residente. Por isso NAO ha supervisor PowerShell aqui: o Task
# Scheduler aponta DIRETO pro cmd.exe/node.exe, porque cada disparo e uma
# execucao curta e completa - exatamente o cenario pra que o Task Scheduler
# foi desenhado (ao contrario do sync financeiro, que e um processo
# perpetuo e brigava com RestartOnFailure - ver watchdog-sync-financeiro.ps1
# pra essa causa raiz. Aqui esse problema simplesmente nao existe: nao ha
# "morte inesperada de processo persistente" pra detectar, cada tick nasce e
# morre sozinho, e o proximo tick do trigger cuida do resto).
#
# Idempotencia real fica no proprio script (upsert por legacy_nfe_id,
# ON CONFLICT DO NOTHING/UPDATE) - reexecutar nunca duplica nota.
#
# So mexe na tarefa VivenzzaSyncFiscalLegado. Nunca toca em
# VivenzzaSyncFinanceiroLegado nem VivenzzaSyncPedidosLegado.
$ErrorActionPreference = 'Stop'
$nomeTarefa = 'VivenzzaSyncFiscalLegado'
$raiz = Split-Path -Parent $PSScriptRoot
$script = Join-Path $raiz 'scripts\sync-vendas-fiscais-legado.mjs'

if (-not (Test-Path $script)) {
  throw "Nao encontrei $script - rode este script a partir do checkout do vivenzza-crm-api."
}

$svc = New-Object -ComObject "Schedule.Service"
$svc.Connect()
$def = $svc.NewTask(0)

$def.RegistrationInfo.Description = 'Sincronizacao periodica NetVision (EN_Notas) -> notas_fiscais_netvision (fiscal read-model, so leitura/espelho - nunca emite NF-e, nunca chama SEFAZ). Alimenta o indicador VENDAS DO MES do dashboard.'

# Principal - S4U (2), sem senha gravada em lugar nenhum. RunLevel 0 =
# Limited (LUA) - mesmo padrao ja comprovado nas outras 2 tarefas residentes.
$def.Principal.UserId = $env:USERNAME
$def.Principal.LogonType = 2
$def.Principal.RunLevel = 0

# Settings - RestartOnFailure NUNCA e tocado (mesma licao aprendida no sync
# financeiro: a propriedade so deve ficar de fora do XML, nunca setada a
# zero/vazio - ver CAUSA RAIZ 6 em instalar-tarefa-sync-financeiro.ps1).
$def.Settings.MultipleInstances = 2   # TASK_INSTANCES_IGNORE_NEW - nunca 2 sincronizacoes fiscais em paralelo
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries = $false
$def.Settings.AllowHardTerminate = $true
$def.Settings.StartWhenAvailable = $true   # se a maquina estava desligada na hora do disparo, roda assim que voltar
$def.Settings.ExecutionTimeLimit = "PT15M"  # execucao curta por natureza (10 mil notas em segundos) - 15min e uma folga generosa, nunca "sem limite" (isso e so pro processo perpetuo do financeiro)
$def.Settings.Enabled = $true
$def.Settings.Hidden = $false

# Trigger unico: diario as 08:00, repetindo a cada 30min por 9h (08:00-17:00)
# - cobre o expediente pedido, sem rodar de madrugada a toa. StartWhenAvailable
# cobre o caso "maquina estava desligada as 08:00" (cai no proximo tick de
# 30min assim que a maquina voltar).
$triggers = $def.Triggers
$dailyTrigger = $triggers.Create(2)  # TASK_TRIGGER_DAILY
$oitoHoras = Get-Date -Hour 8 -Minute 0 -Second 0
$dailyTrigger.StartBoundary = $oitoHoras.ToString("yyyy-MM-ddTHH:mm:ss")
$dailyTrigger.DaysInterval = 1
$dailyTrigger.Repetition.Interval = "PT30M"
$dailyTrigger.Repetition.Duration = "PT9H"
$dailyTrigger.Enabled = $true

# Action - cmd.exe direto (sem supervisor, ver racional no topo do arquivo).
# Log proprio (sync-fiscal.log), nunca no mesmo arquivo do sync financeiro.
$powershellNaoUsado = $null  # (nao usado - deixado fora de proposito, action e cmd.exe/node direto)
$argCmd = "/c cd /d `"$raiz`" && node scripts\sync-vendas-fiscais-legado.mjs >> logs\sync-fiscal.log 2>&1"

$actions = $def.Actions
$action = $actions.Create(0)  # TASK_ACTION_EXEC
$action.Path = 'cmd.exe'
$action.Arguments = $argCmd
$action.WorkingDirectory = $raiz

# Valida e MOSTRA o XML final antes de registrar - nunca regista as cegas
# (mesma disciplina do instalador financeiro).
$xmlFinal = $def.XmlText
Write-Output "=== XML final que sera registrado ==="
Write-Output $xmlFinal
Write-Output "======================================"

if ($xmlFinal -notmatch '<CalendarTrigger>') {
  throw "XML final nao contem o CalendarTrigger esperado - abortando sem registrar."
}
if ($xmlFinal -match '<RestartOnFailure>') {
  throw "XML final contem RestartOnFailure, que nao deveria existir - abortando sem registrar."
}
if ($xmlFinal -match '<Count\s*/>|<Count>\s*</Count>|<Interval>\s*</Interval>|<Duration>\s*</Duration>') {
  throw "XML final contem um elemento obrigatorio vazio - abortando sem registrar."
}
if ($xmlFinal -notmatch '<ExecutionTimeLimit>PT15M</ExecutionTimeLimit>') {
  throw "XML final nao tem ExecutionTimeLimit=PT15M explicito - abortando sem registrar."
}
if ($xmlFinal -notmatch [regex]::Escape('sync-vendas-fiscais-legado.mjs')) {
  throw "XML final nao referencia o script fiscal esperado - abortando sem registrar."
}
if ($xmlFinal -match 'NFE_CERT_SENHA|E01_PASSWORD') {
  throw "XML final contem referencia a segredo - abortando sem registrar (nao deveria acontecer nunca, guarda de seguranca extra)."
}
Write-Output "[instalar-tarefa-fiscal] validacoes basicas do XML passaram"

Stop-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $nomeTarefa -Xml $xmlFinal -Force | Out-Null
Write-Output "[instalar-tarefa-fiscal] tarefa $nomeTarefa registrada via XML validado"

Enable-ScheduledTask -TaskName $nomeTarefa | Out-Null

$logDir = Join-Path $raiz 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $nomeTarefa
$estado = (Get-ScheduledTask -TaskName $nomeTarefa).State
Write-Output "[instalar-tarefa-fiscal] tarefa registrada - estado: $estado, proxima execucao: $($info.NextRunTime)"
Write-Output "[instalar-tarefa-fiscal] concluido - primeiro disparo automatico no proximo horario cheio/meia da janela 08h-17h"
