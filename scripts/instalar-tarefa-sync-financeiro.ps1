# Cria (ou atualiza, se ja existir) a tarefa agendada VivenzzaSyncFinanceiroLegado.
# Espelha o padrao ja comprovado de VivenzzaSyncPedidosLegado (Principal S4U/
# Limited, nunca grava senha na definicao da tarefa) com os ajustes que um
# processo RESIDENTE (--watch, roda pra sempre) precisa e um disparo pontual
# a cada 30min nao precisa:
#   - sem limite de duracao (ExecutionTimeLimit=0, pedidos usa 25min, que
#     mataria o worker financeiro no meio do dia)
#   - reinicio automatico se o processo cair (RestartCount/RestartInterval,
#     pedidos nao precisa disso, o proximo disparo de 30min ja cobre)
#   - trigger de logon + trigger de boot (S4U cobre mesmo sem sessao
#     interativa aberta, diferente da pasta Startup antiga, que so dispara
#     em logon)
#   - MultipleInstances=IgnoreNew (nunca 2 instancias desta tarefa)
$ErrorActionPreference = 'Stop'
$nomeTarefa = 'VivenzzaSyncFinanceiroLegado'
$raiz = Split-Path -Parent $PSScriptRoot
$acaoScript = Join-Path $raiz 'vivenzza-sync-financeiro.bat'

if (-not (Test-Path $acaoScript)) {
  throw "Nao encontrei $acaoScript - rode este script a partir do checkout do vivenzza-crm-api."
}

$action = New-ScheduledTaskAction -Execute $acaoScript -WorkingDirectory $raiz

$triggerLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$triggerBoot = New-ScheduledTaskTrigger -AtStartup

$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -DontStopIfGoingOnBatteries `
  -AllowStartIfOnBatteries `
  -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

$existe = Get-ScheduledTask -TaskName $nomeTarefa -ErrorAction SilentlyContinue
if ($existe) {
  Set-ScheduledTask -TaskName $nomeTarefa -Action $action -Trigger @($triggerLogon, $triggerBoot) -Settings $settings -Principal $principal | Out-Null
  Write-Output "[instalar-tarefa] tarefa $nomeTarefa ja existia - definicao atualizada"
} else {
  $definicao = New-ScheduledTask -Action $action -Trigger @($triggerLogon, $triggerBoot) -Settings $settings -Principal $principal `
    -Description 'Sincronizacao continua NetVision -> CRM (financeiro), vivenzza-crm-api. Residente (--watch), reinicia sozinha se cair. Nao mexer no sync de pedidos (VivenzzaSyncPedidosLegado), tarefa separada.'
  Register-ScheduledTask -TaskName $nomeTarefa -InputObject $definicao | Out-Null
  Write-Output "[instalar-tarefa] tarefa $nomeTarefa criada"
}

Enable-ScheduledTask -TaskName $nomeTarefa | Out-Null
Write-Output "[instalar-tarefa] tarefa habilitada"
