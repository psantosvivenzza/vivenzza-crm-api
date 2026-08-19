# Supervisor do worker financeiro (sync-financeiro-legado.mjs --watch).
#
# CAUSA RAIZ 1 (comprovada empiricamente, 2026-08-19): a Tarefa Agendada
# apontando direto pro .bat (que por sua vez chama node.exe) nao reiniciava
# quando o processo node.exe era morto externamente. LastTaskResult ficava
# em 0xFFFFFFFF (codigo anomalo) e o Task Scheduler nunca tratou isso como
# "falha" o suficiente pra acionar RestartCount/RestartInterval - a
# indirecao .bat -> cmd.exe -> node.exe deixa ambiguo QUAL processo da
# cadeia "e" a tarefa aos olhos do Scheduler quando a morte vem de fora.
# Corrigido: Task Scheduler passa a vigiar SO este script (powershell.exe
# direto, sem .bat no meio) e ESTE script faz sua propria deteccao via
# polling num Process object que ele mesmo criou - sem ambiguidade,
# porque o handle e nosso.
#
# CAUSA RAIZ 2 (comprovada empiricamente logo depois, mesmo dia): a
# primeira versao deste supervisor tinha $ErrorActionPreference='Stop'
# global e a funcao de log usava Add-Content sem tratamento de erro. O
# worker filho (cmd.exe/node.exe) escreve no MESMO arquivo de log via
# redirecionamento de shell (>>) ao mesmo tempo que o supervisor tenta
# logar seus proprios eventos - uma colisao momentanea de acesso ao
# arquivo derrubava o supervisor INTEIRO (Add-Content lancando exception
# com ErrorActionPreference=Stop mata o script todo). O Task Scheduler ate
# reiniciava o supervisor certinho (prova que o restart do proprio
# supervisor funciona bem sem a indirecao .bat) - mas cada nova geracao
# tambem morria do mesmo jeito, e o worker anterior ficava orfao (a morte
# do supervisor nao mata o processo filho detached).
#
# CAUSA RAIZ 3 (comprovada empiricamente na sequencia): a colisao do
# CAUSA RAIZ 2 nao era so "momentanea" - o handle que cmd.exe abre pra
# fazer ">> logs\sync-financeiro.log" fica com lock exclusivo pela vida
# INTEIRA do processo node --watch (confirmado tentando escrever no
# arquivo por fora enquanto o worker rodava: "Device or resource busy").
# Ou seja, o supervisor NUNCA conseguia logar nada enquanto um worker
# estivesse de pe, nem com retry. Corrigido definitivamente: supervisor
# escreve em ARQUIVO PROPRIO (sync-financeiro-supervisor.log), nunca no
# mesmo arquivo que o cmd.exe/node.exe do worker. log() tambem nunca
# lanca (tenta, se falhar espera um instante e tenta 1x de novo, desiste
# em silencio se persistir - perder 1 linha de log nunca pode matar o
# processo de sincronizacao de verdade). ErrorActionPreference global
# voltou a 'Continue' - qualquer outro erro pontual nao-critico tambem
# nao derruba mais o loop inteiro.
#
# Ao iniciar, mata qualquer node.exe/cmd.exe orfao de uma geracao anterior
# do supervisor (self-cleanup) - garante exatamente 1 worker mesmo depois
# de uma sequencia de crashes. Roda sob o MESMO contexto S4U do worker
# (mesmo usuario), entao consegue encerrar esses processos mesmo quando
# uma sessao interativa comum nao consegue (limite de sessao de logon do
# Windows, ja documentado/comprovado nesta mesma investigacao).
#
# Parada intencional (4-PARAR.bat): cria logs\sync-financeiro.stop ANTES
# de matar o processo. Este supervisor ve o arquivo (no inicio do loop OU
# durante o polling) e encerra ele mesmo, em vez de reiniciar - uma parada
# administrativa deliberada nunca vira loop infinito.
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $raiz 'logs'
$logFile = Join-Path $logDir 'sync-financeiro-supervisor.log'
$stopFlag = Join-Path $logDir 'sync-financeiro.stop'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($msg) {
  $carimbo = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  try {
    Add-Content -Path $logFile -Value "[supervisor $carimbo] $msg" -ErrorAction Stop
  } catch {
    Start-Sleep -Milliseconds 300
    try { Add-Content -Path $logFile -Value "[supervisor $carimbo] $msg" -ErrorAction Stop } catch {
      # Best-effort: perder 1 linha de log nunca pode derrubar o supervisor.
    }
  }
}

function MatarWorkersOrfaos {
  $mortos = 0
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'sync-financeiro-legado\.mjs' } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $script:mortos++; Log "orfao node.exe PID $($_.ProcessId) encerrado" }
      catch { Log "nao consegui encerrar orfao node.exe PID $($_.ProcessId): $($_.Exception.Message)" }
    }
  Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'sync-financeiro-legado\.mjs' } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Log "orfao cmd.exe PID $($_.ProcessId) encerrado" }
      catch { Log "nao consegui encerrar orfao cmd.exe PID $($_.ProcessId): $($_.Exception.Message)" }
    }
}

# CAUSA RAIZ 4 (comprovada empiricamente, mesmo dia): mesmo depois de
# corrigir 1-3, novas geracoes do supervisor continuavam morrendo
# sozinhas em poucos minutos, sem NENHUMA linha de log (nem "supervisor
# iniciado" da nova geracao), sem excecao .NET visivel, sem evento de
# crash (Application/PowerShell event log limpos), sem deteccao do
# Windows Defender (checado e confirmado limpo). Causa mais provavel
# (ver CAUSA RAIZ 5 em instalar-tarefa-sync-financeiro.ps1): o proprio
# RestartCount/RestartInterval do Task Scheduler, pensado pra tarefas que
# terminam, nao pra um processo residente - corrigido do lado da
# instalacao (RestartCount=0 + trigger repetido de 5min como rede de
# seguranca em vez disso).
#
# Blindagem adicional aqui, por seguranca (nunca custa manter mesmo
# depois de identificar a causa mais provavel): TUDO roda dentro de um
# loop externo com try/catch - se algo inesperado escapar de todo o
# resto (exception .NET que ignora ErrorActionPreference, por exemplo),
# o supervisor se reinicia SOZINHO por dentro, sem depender do Task
# Scheduler perceber e agir.
while ($true) {
try {
  if (Test-Path $stopFlag) { Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue }
  Log 'supervisor iniciado'
  try { MatarWorkersOrfaos } catch { Log "MatarWorkersOrfaos falhou: $($_.Exception.Message)" }
  Start-Sleep -Seconds 1

  $backoffSegundos = 5
  $poolSegundos = 5

  while ($true) {
    if (Test-Path $stopFlag) {
      Log 'sinal de parada encontrado antes de iniciar - encerrando supervisor'
      Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue
      exit 0
    }

    # Mesma linha de sempre (cd + node --watch >> log 2>&1) - so quem lanca
    # mudou (o supervisor, nao mais diretamente o Task Scheduler). Preserva
    # 100% o comportamento e o formato de log ja em uso.
    $argCmd = "/c cd /d `"$raiz`" && node scripts\sync-financeiro-legado.mjs --watch >> logs\sync-financeiro.log 2>&1"
    $proc = $null
    try {
      $proc = Start-Process -FilePath 'cmd.exe' -ArgumentList $argCmd -WorkingDirectory $raiz -WindowStyle Hidden -PassThru -ErrorAction Stop
      Log "worker iniciado (PID $($proc.Id))"
    } catch {
      Log "FALHA ao iniciar o worker: $($_.Exception.Message) - tentando de novo em ${backoffSegundos}s"
      Start-Sleep -Seconds $backoffSegundos
      continue
    }

    while (-not $proc.HasExited) {
      Start-Sleep -Seconds $poolSegundos
      try { $proc.Refresh() } catch {}

      if (Test-Path $stopFlag) {
        Log 'sinal de parada durante execucao - encerrando worker e supervisor'
        try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
        try { MatarWorkersOrfaos } catch { Log "MatarWorkersOrfaos falhou: $($_.Exception.Message)" }
        Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue
        Log 'supervisor encerrado (parada intencional)'
        exit 0
      }
    }

    Log "worker encerrou (exit code $($proc.ExitCode))"

    if (Test-Path $stopFlag) {
      Log 'parada intencional detectada apos a morte do worker - supervisor encerrando, nao reinicia'
      Remove-Item $stopFlag -Force -ErrorAction SilentlyContinue
      exit 0
    }

    Log "morte inesperada - reiniciando em ${backoffSegundos}s"
    Start-Sleep -Seconds $backoffSegundos
  }
} catch {
  try { Log "EXCECAO NAO TRATADA NO SUPERVISOR: $($_.Exception.GetType().FullName): $($_.Exception.Message) | $($_.InvocationInfo.PositionMessage) - reiniciando o loop interno em 5s" } catch {}
  Start-Sleep -Seconds 5
}
}
