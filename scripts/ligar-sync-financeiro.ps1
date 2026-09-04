# Fase 2E (3a rodada) — chamado por 3-LIGAR.bat (depois das checagens de
# ambiente/tarefa instalada, que continuam no .bat). Primeiro VALIDA (sem
# mutar nada) que a tarefa existe, e consultavel e esta habilitada - acesso
# negado na consulta permanece "acesso negado", nunca vira "tarefa
# inexistente". So depois remove o sinalizador e CONFIRMA explicitamente
# que sumiu antes de tocar no Scheduler; nunca chama Enable-ScheduledTask
# em caminho nenhum. So imprime sucesso depois que o WATCHDOG grava um ack
# Estado=Rodando com o RequestId EXATO desta chamada (nunca aceita
# heartbeat sozinho, nunca aceita ack de outro RequestId) - nunca antes
# disso, e nunca baseado em WMI. Se o ack exato nao chegar a tempo (mesmo
# com um watchdog ja ativo respondendo), o sinalizador e RESTAURADO
# automaticamente antes deste script terminar (rollback transacional).
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'sync-financeiro-control.psm1') -Force

$raiz = Split-Path -Parent $PSScriptRoot

try {
  $resultado = Invoke-SyncFinanceiroLigar -Raiz $raiz -NomeTarefa 'VivenzzaSyncFinanceiroLegado' -TimeoutSegundos 30 -IntervaloSegundos 2
} catch {
  Write-Output ''
  Write-Output "ERRO INESPERADO ao tentar ligar: $($_.Exception.Message)"
  exit 1
}

Write-Output ''
if ($resultado.Sucesso -and $resultado.JaEstavaRodando) {
  Write-Output "Worker ja estava rodando - nada a iniciar (sinalizador removido e confirmado ausente; RequestId=$($resultado.RequestId))."
  exit 0
} elseif ($resultado.Sucesso) {
  Write-Output "Sinalizador removido e confirmado ausente, tarefa acionada, worker confirmado de pe pelo watchdog usando o handle real do processo Node (RequestId=$($resultado.RequestId))."
  exit 0
} else {
  Write-Output "NAO CONSEGUI LIGAR: $($resultado.Erro)"
  if ($null -ne $resultado.RollbackConfirmado) {
    if ($resultado.RollbackConfirmado) {
      Write-Output '  - o sinalizador de parada foi RESTAURADO e CONFIRMADO (rollback ok) - o sistema continua protegido no estado parado.'
    } else {
      Write-Output '  - ATENCAO: o rollback do sinalizador TAMBEM falhou - estado indeterminado, verifique manualmente antes de tentar de novo.'
    }
  }
  exit 1
}
