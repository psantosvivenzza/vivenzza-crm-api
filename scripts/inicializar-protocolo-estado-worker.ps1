# Fase 2E (5a rodada) — bootstrap EXPLÍCITO e ÚNICO do protocolo de estados
# do worker financeiro. NUNCA é chamado automaticamente pelo watchdog -
# só deve ser rodado manualmente, uma vez, durante o release controlado.
#
# PROCEDIMENTO (nesta ordem, ver tambem o comentario grande no topo de
# scripts\sync-financeiro-control.psm1):
#   1. ANTES do `git pull`, o checkout ainda tem o 4-PARAR.bat ANTIGO (sem
#      o protocolo de estados). Use o procedimento DIRETO ja comprovado na
#      Fase 2D: criar logs\sync-financeiro.stop manualmente e confirmar a
#      parada PELOS LOGS do supervisor (logs\sync-financeiro-supervisor.log),
#      nunca pelo protocolo novo (que ainda nao existe no codigo rodando
#      nesse momento).
#   2. `git pull`.
#   3. SO ENTAO rode este script, passando -Confirmo (so depois de ter
#      certeza, pelo passo 1, de que nao ha worker antigo rodando).
#   4. 3-LIGAR.bat normalmente a partir daqui.
#
# Recusa rodar sem -Confirmo, e recusa rodar de novo se um arquivo de
# estado JA EXISTIR (mesmo Unknown/corrompido) - nao e um "reset", so a
# primeira inicializacao.
param(
  [switch]$Confirmo
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'sync-financeiro-control.psm1') -Force

$raiz = Split-Path -Parent $PSScriptRoot

if (-not $Confirmo) {
  Write-Output ''
  Write-Output 'NAO EXECUTADO: este script precisa da flag -Confirmo.'
  Write-Output ''
  Write-Output 'So rode isto DEPOIS de confirmar, pelo procedimento direto da Fase 2D'
  Write-Output '(sinalizador de parada + logs do supervisor), que nenhum worker antigo'
  Write-Output 'esta rodando. Ver o comentario no topo deste arquivo.'
  Write-Output ''
  Write-Output '  scripts\inicializar-protocolo-estado-worker.ps1 -Confirmo'
  Write-Output ''
  exit 1
}

try {
  $resultado = Initialize-SyncFinanceiroEstadoWorker -Raiz $raiz -ConfirmeiQueNenhumWorkerAntigoEstaRodando
} catch {
  Write-Output ''
  Write-Output "ERRO INESPERADO ao inicializar o protocolo: $($_.Exception.Message)"
  exit 1
}

Write-Output ''
if ($resultado.Sucesso) {
  Write-Output "Protocolo de estados inicializado: Estado=Stopped, GeracaoId=$($resultado.GeracaoId)"
  Write-Output 'Rode 3-LIGAR.bat normalmente a partir daqui.'
  exit 0
} else {
  Write-Output "NAO CONSEGUI INICIALIZAR: $($resultado.Erro)"
  exit 1
}
