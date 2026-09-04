# Fase 2E (3a rodada) — chamado por 4-PARAR.bat. Cria o sinalizador
# persistente (com um RequestId novo) e so imprime "desligada" depois que o
# WATCHDOG confirma a parada usando o proprio handle do processo Node REAL
# (nao mais o cmd.exe que o lancava) - nunca WMI, nunca a contagem de
# processos vista por esta sessao interativa (diagnostico apenas), e nunca
# so porque uma geracao nova do watchdog "nao iniciou nada" (a limpeza de
# orfaos de uma geracao anterior precisa confirmar positivamente zero
# processos restantes - ver comentario grande no topo de
# scripts\sync-financeiro-control.psm1 e scripts\watchdog-sync-financeiro.ps1).
# Nunca mata processo aqui, nunca precisa de privilegio elevado, nunca
# chama schtasks.
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'sync-financeiro-control.psm1') -Force

$raiz = Split-Path -Parent $PSScriptRoot

try {
  $resultado = Invoke-SyncFinanceiroParar -Raiz $raiz -NomeTarefa 'VivenzzaSyncFinanceiroLegado' -TimeoutSegundos 30 -IntervaloSegundos 2
} catch {
  Write-Output ''
  Write-Output "ERRO INESPERADO ao tentar parar: $($_.Exception.Message)"
  exit 1
}

Write-Output ''
if ($resultado.Sucesso) {
  Write-Output 'Sincronizacao financeira desligada:'
  Write-Output "  - RequestId=$($resultado.RequestId)"
  Write-Output '  - sinalizador persistente criado (logs\sync-financeiro.stop)'
  Write-Output '  - o WATCHDOG confirmou a parada usando o proprio handle do processo filho (nao depende de WMI/consulta de processos)'
  Write-Output '  - Tarefa Agendada continua habilitada de proposito; o sinalizador impede o worker de subir de novo'
  Write-Output "  - (diagnostico, NAO autoritativo) processos vistos via WMI por esta sessao: $($resultado.ProcessosRestantes)"
  Write-Output ''
  Write-Output 'Rode 3-LIGAR.bat quando quiser religar.'
  exit 0
} else {
  Write-Output 'NAO CONSEGUI CONFIRMAR A PARADA dentro do prazo.'
  Write-Output "  - RequestId=$($resultado.RequestId)"
  if ($resultado.ConfirmacaoWatchdog) {
    Write-Output "  - ultima confirmacao registrada pelo watchdog: $($resultado.ConfirmacaoWatchdog | ConvertTo-Json -Compress)"
  } else {
    Write-Output '  - nenhuma confirmacao foi registrada pelo watchdog ainda'
  }
  Write-Output "  - (diagnostico, NAO autoritativo) processos vistos via WMI por esta sessao: $($resultado.ProcessosRestantes)"
  if ($resultado.ErroAoAcionarTarefa) {
    Write-Output "  - erro ao tentar acionar a Tarefa Agendada (empurrao pra garantir um watchdog vivo): $($resultado.ErroAoAcionarTarefa)"
  }
  Write-Output '  - o sinalizador foi criado, mas nenhum watchdog confirmou a parada a tempo'
  Write-Output '  - NAO reinicie nem force nada manualmente; verifique logs\sync-financeiro-supervisor.log'
  exit 1
}
