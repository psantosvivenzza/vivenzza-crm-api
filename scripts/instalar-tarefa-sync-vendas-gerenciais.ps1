# Cria (ou substitui, se ja existir) a tarefa agendada
# VivenzzaSyncVendasGerenciaisLegado.
# Precisa rodar como Administrador (Principal S4U exige elevacao neste
# Windows) - script unico, idempotente, seguro de rodar de novo quantas
# vezes for preciso.
#
# ARQUITETURA: mesmo padrao do sync fiscal (PR #51) - script de tiro unico
# (scripts/sync-vendas-gerenciais-legado.mjs, sem --watch), Task Scheduler
# aponta DIRETO pro cmd.exe/node, sem supervisor (nao ha "morte inesperada
# de processo persistente" pra detectar aqui - cada tick nasce e morre
# sozinho). Ver instalar-tarefa-sync-fiscal.ps1 pro racional completo dessa
# escolha de arquitetura.
#
# DOMINIO SEPARADO do sync fiscal por proposito - EN_NotasRepres (gerencial,
# inclui Serie 99) e EN_Notas (fiscal, notas_fiscais_netvision) sao fontes
# NetVision estruturalmente diferentes que nao reconciliam entre si (ver
# VENDAS_DO_MES_RECONCILIACAO.md) - por isso tarefa, log e tabela de sync
# proprios, nunca compartilhados com o fiscal.
#
# Idempotencia real fica no proprio script (upsert por legacy_id, ON
# CONFLICT DO NOTHING/UPDATE) - reexecutar nunca duplica venda.
#
# So mexe na tarefa VivenzzaSyncVendasGerenciaisLegado. Nunca toca em
# VivenzzaSyncFinanceiroLegado, VivenzzaSyncFiscalLegado nem
# VivenzzaSyncPedidosLegado.
$ErrorActionPreference = 'Stop'
$nomeTarefa = 'VivenzzaSyncVendasGerenciaisLegado'
$raiz = Split-Path -Parent $PSScriptRoot
$script = Join-Path $raiz 'scripts\sync-vendas-gerenciais-legado.mjs'

if (-not (Test-Path $script)) {
  throw "Nao encontrei $script - rode este script a partir do checkout do vivenzza-crm-api."
}

$svc = New-Object -ComObject "Schedule.Service"
$svc.Connect()
$def = $svc.NewTask(0)

$def.RegistrationInfo.Description = 'Sincronizacao periodica NetVision (EN_NotasRepres) -> vendas_gerenciais_netvision (read-model GERENCIAL, so leitura/espelho - nunca emite NF-e, nunca chama SEFAZ). Alimenta o indicador VENDAS DO MES (gerencial, inclui Serie 99) do dashboard - dominio separado do sync fiscal.'

# Principal - S4U (2), sem senha gravada em lugar nenhum. RunLevel 0 =
# Limited (LUA) - mesmo padrao ja comprovado nas outras tarefas residentes.
$def.Principal.UserId = $env:USERNAME
$def.Principal.LogonType = 2
$def.Principal.RunLevel = 0

# Settings - RestartOnFailure NUNCA e tocado (mesma licao aprendida no sync
# financeiro - a propriedade so deve ficar de fora do XML).
$def.Settings.MultipleInstances = 2   # TASK_INSTANCES_IGNORE_NEW - nunca 2 sincronizacoes gerenciais em paralelo
$def.Settings.DisallowStartIfOnBatteries = $false
$def.Settings.StopIfGoingOnBatteries = $false
$def.Settings.AllowHardTerminate = $true
$def.Settings.StartWhenAvailable = $true   # se a maquina estava desligada na hora do disparo, roda assim que voltar
$def.Settings.ExecutionTimeLimit = "PT15M"  # execucao curta por natureza - 15min e uma folga generosa, nunca "sem limite"
$def.Settings.Enabled = $true
$def.Settings.Hidden = $false

# Trigger unico: diario as 08:05 (5min de defasagem do sync fiscal, so pra
# nao competir por I/O no mesmo instante exato - sem necessidade tecnica
# real, MultipleInstances e por tarefa, nao global), repetindo a cada 30min
# por 9h (08:05-17:05) - cobre o expediente pedido. StartWhenAvailable cobre
# o caso "maquina estava desligada as 08:05".
$triggers = $def.Triggers
$dailyTrigger = $triggers.Create(2)  # TASK_TRIGGER_DAILY
$oitoHoras = Get-Date -Hour 8 -Minute 5 -Second 0
$dailyTrigger.StartBoundary = $oitoHoras.ToString("yyyy-MM-ddTHH:mm:ss")
$dailyTrigger.DaysInterval = 1
$dailyTrigger.Repetition.Interval = "PT30M"
$dailyTrigger.Repetition.Duration = "PT9H"
$dailyTrigger.Enabled = $true

# Action - cmd.exe direto (sem supervisor, ver racional no topo do arquivo).
# Log proprio (sync-vendas-gerenciais.log), nunca no mesmo arquivo de outro
# dominio (financeiro/fiscal/pedidos).
$argCmd = "/c cd /d `"$raiz`" && node scripts\sync-vendas-gerenciais-legado.mjs >> logs\sync-vendas-gerenciais.log 2>&1"

$actions = $def.Actions
$action = $actions.Create(0)  # TASK_ACTION_EXEC
$action.Path = 'cmd.exe'
$action.Arguments = $argCmd
$action.WorkingDirectory = $raiz

# Valida e MOSTRA o XML final antes de registrar - nunca regista as cegas
# (mesma disciplina dos instaladores anteriores).
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
if ($xmlFinal -notmatch [regex]::Escape('sync-vendas-gerenciais-legado.mjs')) {
  throw "XML final nao referencia o script gerencial esperado - abortando sem registrar."
}
if ($xmlFinal -match 'NFE_CERT_SENHA|E01_PASSWORD') {
  throw "XML final contem referencia a segredo - abortando sem registrar (nao deveria acontecer nunca, guarda de seguranca extra)."
}
Write-Output "[instalar-tarefa-vendas-gerenciais] validacoes basicas do XML passaram"

Stop-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue

Register-ScheduledTask -TaskName $nomeTarefa -Xml $xmlFinal -Force | Out-Null
Write-Output "[instalar-tarefa-vendas-gerenciais] tarefa $nomeTarefa registrada via XML validado"

Enable-ScheduledTask -TaskName $nomeTarefa | Out-Null

$logDir = Join-Path $raiz 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$info = Get-ScheduledTaskInfo -TaskName $nomeTarefa
$estado = (Get-ScheduledTask -TaskName $nomeTarefa).State
Write-Output "[instalar-tarefa-vendas-gerenciais] tarefa registrada - estado: $estado, proxima execucao: $($info.NextRunTime)"
Write-Output "[instalar-tarefa-vendas-gerenciais] concluido - primeiro disparo automatico no proximo horario da janela 08h05-17h05"
