# Supervisor do worker financeiro (sync-financeiro-legado.mjs --watch).
#
# CAUSA RAIZ 1 (comprovada empiricamente, 2026-08-19): a Tarefa Agendada
# apontando direto pro .bat (que por sua vez chama node.exe) nao reiniciava
# quando o processo node.exe era morto externamente. Corrigido: Task
# Scheduler passa a vigiar SO este script (powershell.exe direto, sem .bat
# no meio) e ESTE script faz sua propria deteccao via polling num Process
# object que ele mesmo criou - sem ambiguidade, porque o handle e nosso.
#
# CAUSA RAIZ 2/3 (comprovadas empiricamente, mesmo dia): supervisor precisa
# de log PROPRIO (nunca no mesmo arquivo que o worker escreve, que fica com
# lock exclusivo pela vida inteira do processo) e log() nunca pode lancar
# (best-effort, 1 retry, desiste em silencio) - perder 1 linha de log nunca
# pode matar o processo de sincronizacao de verdade.
#
# CORRECAO FASE 2E (1a rodada): o supervisor NUNCA remove o sinalizador de
# parada, em nenhum dos pontos onde o checa. So 3-LIGAR.bat (via
# Remove-SyncFinanceiroFlag) remove.
#
# CORRECAO FASE 2E (2a rodada): este script passou a ser o unico
# responsavel por confirmar parada/inicio, via protocolo de pedido/
# confirmacao (request/ack/heartbeat, JSON com RequestId unico por
# chamada) em scripts\sync-financeiro-control.psm1 - nunca mais WMI feito
# pela sessao interativa.
#
# CORRECAO FASE 2E (3a rodada): o worker passou a ser iniciado e rastreado
# DIRETAMENTE (sem cmd.exe no meio) - Stop-Process/$proc.HasExited passam a
# ser autoritativos pro processo REAL.
#
# CORRECAO FASE 2E (4a rodada): ausencia de worker anterior confirmada
# virou pre-condicao UNIVERSAL pra iniciar (com ou sem sinalizador de
# parada) - ver Invoke-SyncFinanceiroWatchdogInicioComRetentativas.
#
# CORRECAO FASE 2E (5a rodada) — revisao independente substituiu a
# identidade PID+StartTime (com tolerancia de 1s, arquivo removido em toda
# parada) por uma MAQUINA DE ESTADOS explicita e persistente
# (logs\sync-financeiro.worker-state.json, ver o comentario grande no topo
# de scripts\sync-financeiro-control.psm1 pro modelo completo e o
# procedimento de BOOTSTRAP). Mudancas neste script:
#   (a) cada geracao gera um GeracaoId novo e usa
#       Invoke-SyncFinanceiroWatchdogPartidaTransacional pra reivindicar
#       Starting, iniciar o processo, e gravar Running - QUALQUER falha
#       depois que o processo ja existe desfaz a partida por completo
#       (encerra pelo handle real, confirma, drena, libera tracking, grava
#       Stopped se a morte foi comprovada ou Unknown se nao foi) antes de
#       devolver o controle - nunca deixa o filho anterior vivo, nunca
#       produz ACK "Rodando" sobre uma partida que falhou.
#   (b) a mensagem de EstadoIncerto agora e explicita: nunca diz
#       "confirmacao registrada" quando nada foi confirmado - diz
#       claramente que nenhum ack foi gravado e nenhum worker foi
#       iniciado, e qual vai ser a proxima tentativa.
#   (c) o catch EXTERNO (mais de fora) tambem limpa qualquer handle que ja
#       tenha sido criado antes de reiniciar o loop - variavel de rastreio
#       fora do try, pra nunca perder um processo vivo numa excecao
#       verdadeiramente inesperada.
#   (d) Start-SyncFinanceiroWorkerProcesso/Stop-SyncFinanceiroWorkerTracking
#       moraram pro modulo desde a 4a rodada; nesta, a criacao das DUAS
#       assinaturas de evento passou pra DENTRO do try de aquisicao (achado
#       da revisao: se a segunda falhasse, a primeira/writer ficavam sem
#       liberar).
#
# CORRECAO FASE 2E (6a rodada) — exclusao mutua REAL entre geracoes (lock
# cross-process), ACK como ultimo registro de "commit", e nunca descartar
# um handle cuja morte nao foi confirmada:
#   (a) Invoke-SyncFinanceiroWatchdogInicioComRetentativas agora EXIGE
#       -GeracaoId - a reivindicacao de Starting acontece ATOMICAMENTE
#       dentro dela (sob lock cross-process), nao mais separada em
#       Invoke-SyncFinanceiroWatchdogPartidaTransacional.
#   (b) morte NATURAL do worker: PID/exit code sao capturados e
#       Estado=Stopped e persistido ANTES de Stop-SyncFinanceiroWorkerTracking
#       (que descarta/Dispose o Process) - nunca acessa propriedades do
#       objeto Process depois de descartado.
#   (c) parada intencional (sinal durante execucao) usa
#       Invoke-SyncFinanceiroWatchdogPararEConfirmar, que so publica o ACK
#       Parado DEPOIS de persistir Estado=Stopped com sucesso.
#   (d) se uma partida falha SEM confirmar a morte do processo (Handle
#       volta preenchido), o supervisor NUNCA inicia outra geracao/worker -
#       entra num loop dedicado de retentativa sobre o MESMO handle/
#       GeracaoId ate confirmar, tanto no caminho normal quanto no catch
#       externo.
#
# CORRECAO FASE 2E (7a rodada) — o lock de estado (transicao curta,
# liberado em segundos) NAO impedia que uma SEGUNDA instancia do
# supervisor (ex.: dois disparos do Scheduler sobrepostos) coexistisse
# depois que a primeira ja tivesse chegado a Running: a segunda, ao
# reconciliar, poderia decidir encerrar um worker SAUDAVEL da primeira.
# Corrigido com um LOCK DE INSTANCIA separado (arquivo fixo distinto do
# lock de estado), adquirido logo no INICIO do script e mantido aberto
# (nunca fechado explicitamente) ate a saida do processo inteiro - o SO
# libera sozinho se o supervisor morrer. Se a aquisicao falhar (outra
# instancia ja viva), este processo sai IMEDIATAMENTE, ANTES de qualquer
# chamada de reconciliacao/decisao de inicio - nunca reconcilia, mata ou
# inicia worker nenhum.
#
# Blindagem geral (mantida de investigacoes anteriores): TUDO roda dentro
# de um loop externo com try/catch - se algo inesperado escapar de todo o
# resto, o supervisor se reinicia SOZINHO por dentro, sem depender do Task
# Scheduler perceber e agir (ver CAUSA RAIZ 4 - RestartCount/RestartInterval
# do Scheduler nao serve pra processo residente, corrigido do lado da
# instalacao com trigger repetido de 5min como rede de seguranca).
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $raiz 'logs'
$logFile = Join-Path $logDir 'sync-financeiro-supervisor.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Import-Module (Join-Path $PSScriptRoot 'sync-financeiro-control.psm1') -Force

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

# CORRECAO FASE 2E (7a rodada): lock de INSTANCIA adquirido AQUI, antes de
# QUALQUER outra coisa (antes mesmo dos parametros de configuracao) -
# nenhuma chamada de reconciliacao/decisao/processo pode acontecer se este
# supervisor nao for a UNICA instancia viva para este diretorio. O Stream
# fica guardado numa variavel de escopo de script e NUNCA e fechado
# explicitamente - permanece aberto (FileShare.None) ate o processo
# terminar (normal ou crash), quando o SO libera sozinho.
$resultadoLockInstancia = Invoke-SyncFinanceiroAdquirirLockInstancia -Raiz $raiz
if (-not $resultadoLockInstancia.Adquirido) {
  Log "OUTRA INSTANCIA do supervisor ja esta ativa para este diretorio (lock de instancia em uso) - encerrando IMEDIATAMENTE, SEM reconciliar, matar ou iniciar worker nenhum: $($resultadoLockInstancia.Erro)"
  exit 0
}
Log 'lock de instancia adquirido - este e o UNICO supervisor ativo para este diretorio'

$minUptimeSegundos = 5
$intervaloConfirmacaoInicioSegundos = 1
$poolSegundos = 5
$backoffSegundos = 5
$timeoutConfirmacaoParadaSegundos = 30
$maxTentativasInicio = 3
$intervaloTentativasInicioSegundos = 5
$logWorkerPath = Join-Path $logDir 'sync-financeiro.log'
$nomeScriptWorker = 'scripts\sync-financeiro-legado.mjs'

# CORRECAO FASE 2E (5a rodada), item (c): rastreio FORA do try - se uma
# excecao verdadeiramente inesperada escapar de tudo, o catch externo
# ainda precisa saber se existe um handle vivo (e de qual geracao) pra
# desfazer a partida por completo antes de reiniciar o loop.
$handleWorkerAtual = $null
$geracaoIdAtual = $null

while ($true) {
  try {
    # ── RETOMADA DE UM HANDLE PENDENTE (Fase 2E, 6a rodada) ──────────────
    # Se a iteracao anterior terminou com um handle cuja morte NAO foi
    # confirmada (Estado=Unknown persistido, processo ainda pode estar
    # vivo), NUNCA reivindica uma geracao nova nem inicia outro worker -
    # so tenta de novo parar/reconciliar o MESMO handle/GeracaoId ate
    # confirmar.
    if ($handleWorkerAtual) {
      Log "retomando: handle pendente da GeracaoId=$geracaoIdAtual ainda SEM morte confirmada - tentando parar/reconciliar de novo antes de qualquer outra coisa (nunca inicia outro worker/geracao sobre esta incerteza)"
      $tentativaDesfazimento = Invoke-SyncFinanceiroWatchdogDesfazerPartida -Raiz $raiz -GeracaoId $geracaoIdAtual -Handle $handleWorkerAtual -TimeoutSegundos $timeoutConfirmacaoParadaSegundos
      if ($tentativaDesfazimento.Confirmado) {
        Log "morte do worker anterior finalmente confirmada (EstadoPersistido=$($tentativaDesfazimento.EstadoPersistido)) - liberando a geracao presa"
        $handleWorkerAtual = $null
        $geracaoIdAtual = $null
      } else {
        $motivoPersistencia = if (-not $tentativaDesfazimento.EstadoPersistido) { ", ErroPersistencia=$($tentativaDesfazimento.ErroPersistencia)" } else { '' }
        Log "AINDA NAO confirmado (EstadoPersistido=$($tentativaDesfazimento.EstadoPersistido)$motivoPersistencia) - aguardando ${backoffSegundos}s e tentando de novo sobre o MESMO handle/geracao"
        $handleWorkerAtual = $tentativaDesfazimento.Handle
        Start-Sleep -Seconds $backoffSegundos
        continue
      }
    }

    $geracaoIdAtual = [guid]::NewGuid().ToString()
    Log "supervisor iniciado (GeracaoId=$geracaoIdAtual)"

    $decisaoInicio = Invoke-SyncFinanceiroWatchdogInicioComRetentativas -Raiz $raiz -GeracaoId $geracaoIdAtual -MaxTentativas $maxTentativasInicio -IntervaloSegundos $intervaloTentativasInicioSegundos `
      -Dormir { param($s) Start-Sleep -Seconds $s }

    if ($decisaoInicio.EstadoIncerto) {
      # CORRECAO FASE 2E (5a rodada): mensagem EXPLICITA - nunca diz
      # "confirmacao registrada" quando nada foi confirmado.
      Log "ATENCAO: estado anterior do worker NAO PODE SER CONFIRMADO SEGURO apos $maxTentativasInicio tentativa(s) (EstadoAnterior=$($decisaoInicio.EstadoAnterior), MotivoBloqueio=$($decisaoInicio.MotivoBloqueio)) - NENHUM ack foi gravado, NENHUM worker foi iniciado nesta geracao"
      if (Test-SyncFinanceiroFlagPresente -Raiz $raiz) {
        Log 'sinalizador de parada tambem presente - continua SEM confirmar (sinalizador preservado); a proxima geracao (disparo natural do Scheduler) tentara reconciliar de novo'
      } else {
        Log 'sem sinalizador de parada - encerrando esta geracao SEM iniciar worker (evita duplicidade sobre estado incerto); nova tentativa ocorrera no proximo disparo natural do Scheduler'
      }
      $geracaoIdAtual = $null
      exit 0
    }

    if (-not $decisaoInicio.DeveIniciarWorker) {
      # Unico outro motivo possivel: sinalizador presente E estado
      # confirmado seguro (Stopped, ou Running->confirmado morto agora).
      Log "sinalizador de parada presente ao iniciar (RequestId=$($decisaoInicio.RequestIdConfirmado), EstadoAnterior=$($decisaoInicio.EstadoAnterior)) - ausencia de worker anterior CONFIRMADA, ack de parada registrado, encerrando sem subir worker (sinalizador preservado)"
      $geracaoIdAtual = $null
      exit 0
    }

    # CORRECAO FASE 2E (6a rodada): Starting JA FOI reivindicado
    # ATOMICAMENTE para $geracaoIdAtual dentro da chamada acima
    # (Reivindicado=$true) - NAO ha mais um loop interno de "tentativas"
    # reaproveitando o mesmo GeracaoId; cada nova tentativa de subir um
    # worker, daqui pra frente, sempre passa por uma volta NOVA deste loop
    # (GeracaoId novo, reivindicacao atomica nova).
    Start-Sleep -Seconds 1

    if (Test-SyncFinanceiroFlagPresente -Raiz $raiz) {
      # Starting ja reivindicado, mas nenhum processo chegou a nascer -
      # transita direto pra Stopped (escrita PROTEGIDA - esta geracao e a
      # dona legitima de Starting) e SO ENTAO confirma via ack (mesma regra
      # de "ACK por ultimo" do resto do protocolo).
      $rEstado = Set-SyncFinanceiroEstadoWorker -Raiz $raiz -Estado 'Stopped' -GeracaoId $geracaoIdAtual
      if ($rEstado.Sucesso) {
        $confirmacao = Confirm-SyncFinanceiroParadaAposSaidaNatural -Raiz $raiz
        Log "sinal de parada encontrado antes de iniciar (RequestId=$($confirmacao.RequestIdConfirmado)) - Starting revertido pra Stopped e confirmacao registrada, encerrando supervisor (sinalizador preservado)"
      } else {
        Log "ATENCAO: sinal de parada encontrado antes de iniciar, mas FALHA ao persistir Stopped ($($rEstado.Erro)) - NAO publiquei ACK; a proxima geracao reconcilia"
      }
      $geracaoIdAtual = $null
      exit 0
    }

    # ── PARTIDA TRANSACIONAL (Fase 2E, 5a/6a rodada) ─────────────────────
    # Starting ja reivindicado (ver acima) - esta funcao so inicia o
    # processo REAL, grava Running, e tenta confirmar um pedido de Ligar
    # pendente (-PosRunning). QUALQUER falha depois que o processo ja
    # existe desfaz tudo (ver a funcao no modulo) - se a morte NAO for
    # confirmada, o Handle preenchido no resultado precisa ser preservado.
    $resultadoPartida = Invoke-SyncFinanceiroWatchdogPartidaTransacional -Raiz $raiz -GeracaoId $geracaoIdAtual `
      -IniciarProcesso {
      $h = Start-SyncFinanceiroWorkerProcesso -FileName 'node.exe' -Argumentos "$nomeScriptWorker --watch" -WorkingDirectory $raiz -LogPath $logWorkerPath
      Log "worker iniciado (PID $($h.Processo.Id), StartTime=$($h.Processo.StartTime.ToString('o')), node.exe direto - sem cmd.exe intermediario)"
      $h
    } `
      -PosRunning {
      param($Handle)
      $proc = $Handle.Processo
      $reqAtual = Get-SyncFinanceiroRequestAtual -Raiz $raiz
      if ($reqAtual -and $reqAtual.Tipo -eq 'Ligar') {
        $confirmacaoInicio = Invoke-SyncFinanceiroWatchdogConfirmarInicio -Raiz $raiz -RequestId $reqAtual.RequestId -WorkerPid $proc.Id `
          -AindaVivo { $proc.Refresh(); -not $proc.HasExited } `
          -MinUptimeSegundos $minUptimeSegundos -IntervaloSegundos $intervaloConfirmacaoInicioSegundos `
          -Dormir { param($s) Start-Sleep -Seconds $s }
        if ($confirmacaoInicio.Confirmado) { Log "inicio confirmado (RequestId=$($reqAtual.RequestId), PID $($proc.Id) [node.exe direto], vivo por >= ${minUptimeSegundos}s)" }
        else { Log 'worker (node.exe) morreu antes do periodo minimo de confirmacao de inicio - nao registrei confirmacao (morte NATURAL, tratada pelo loop de monitoramento normal, nao aciona desfazimento transacional)' }
      }
    } `
      -TimeoutDesfazimentoSegundos $timeoutConfirmacaoParadaSegundos

    if (-not $resultadoPartida.Sucesso) {
      if ($resultadoPartida.Handle) {
        # Morte NAO confirmada - o handle preenchido no resultado precisa
        # ser preservado (nunca perdido); a proxima volta deste loop
        # retoma a reconciliacao sobre ele, sem nunca iniciar outro
        # worker/geracao.
        Log "FALHA na partida transacional (processo NAO confirmado morto): $($resultadoPartida.Erro) - handle preservado, retomando reconciliacao na proxima volta do loop (backoff ${backoffSegundos}s)"
        $handleWorkerAtual = $resultadoPartida.Handle
      } else {
        Log "FALHA na partida transacional: $($resultadoPartida.Erro) - nao reinicia sobre um estado que pode estar incerto; proxima volta do loop reivindica uma geracao nova (backoff ${backoffSegundos}s)"
        $geracaoIdAtual = $null
      }
      Start-Sleep -Seconds $backoffSegundos
      continue
    }

    $handleWorkerAtual = $resultadoPartida.Handle
    $proc = $handleWorkerAtual.Processo

    while (-not $proc.HasExited) {
      Start-Sleep -Seconds $poolSegundos
      try { $proc.Refresh() } catch {}

      if (Test-SyncFinanceiroFlagPresente -Raiz $raiz) {
        Log 'sinal de parada durante execucao - tentando encerrar worker (handle proprio do processo Node)'
        $tokenParada = Get-SyncFinanceiroRequestIdDeParada -Raiz $raiz
        $pidParaParar = $null
        try { $pidParaParar = $proc.Id } catch {}
        # CORRECAO FASE 2E (6a rodada): Invoke-SyncFinanceiroWatchdogPararEConfirmar
        # so publica o ACK Parado DEPOIS de persistir Estado=Stopped com
        # sucesso - nunca antes.
        $resultadoParada = Invoke-SyncFinanceiroWatchdogPararEConfirmar -Raiz $raiz -GeracaoId $geracaoIdAtual -RequestId $tokenParada -WorkerPid $pidParaParar `
          -PararProcesso { Stop-Process -Id $pidParaParar -Force -ErrorAction Stop } `
          -ProcessoSaiu { $proc.Refresh(); $proc.HasExited } `
          -DrenarSaida { Wait-SyncFinanceiroSaidaDrenada -Processo $proc } `
          -TimeoutSegundos $timeoutConfirmacaoParadaSegundos -IntervaloSegundos 1 `
          -Dormir { param($s) Start-Sleep -Seconds $s }

        if ($resultadoParada.Confirmado -and $resultadoParada.EstadoPersistido) {
          Log "worker (node.exe, PID $pidParaParar) confirmado encerrado, Estado=Stopped persistido e ACK publicado=$($resultadoParada.AckPublicado) (RequestId=$tokenParada) - parada intencional"
          Stop-SyncFinanceiroWorkerTracking -Handle $handleWorkerAtual | Out-Null
          $handleWorkerAtual = $null
          $geracaoIdAtual = $null
          Log 'supervisor encerrado (parada intencional)'
          exit 0
        } elseif ($resultadoParada.Confirmado) {
          Log "ATENCAO: worker confirmado encerrado mas FALHA ao persistir Estado=Stopped ($($resultadoParada.Erro)) - ACK Parado NAO publicado; processo real ja nao existe mais, encerrando o supervisor mesmo assim (a proxima geracao reconcilia via PID/StartTimeUtc)"
          Stop-SyncFinanceiroWorkerTracking -Handle $handleWorkerAtual | Out-Null
          $handleWorkerAtual = $null
          $geracaoIdAtual = $null
          exit 0
        } else {
          Log 'ATENCAO: worker (node.exe) nao confirmou encerramento dentro do prazo apos Stop-Process - handle PRESERVADO (nao descartado), NAO publiquei ACK, NAO persisti Stopped - tentando de novo no proximo ciclo de monitoramento'
        }
      }

      # Idempotencia do Ligar enquanto ja rodando: responde a um pedido
      # novo (ou so atualiza o heartbeat) sem reiniciar nada.
      $resultadoExecucao = Update-SyncFinanceiroWatchdogEmExecucao -Raiz $raiz -WorkerPid $proc.Id -AindaVivo { $proc.Refresh(); -not $proc.HasExited }
      if ($resultadoExecucao.AckAtualizado) { Log "confirmacao de 'ja rodando' registrada para o pedido de Ligar atual" }
    }

    # CORRECAO FASE 2E (6a rodada): captura PID/exit code ANTES de
    # descartar o tracking (Stop-SyncFinanceiroWorkerTracking faz
    # Process.Dispose()) - e persiste Estado=Stopped ANTES do Dispose,
    # nunca depois. Nunca acessa propriedades de $proc apos essa chamada.
    $pidFinal = $null
    try { $pidFinal = $proc.Id } catch {}
    try { Wait-SyncFinanceiroSaidaDrenada -Processo $proc } catch {}
    $exitCodeFinal = $null
    try { $exitCodeFinal = $proc.ExitCode } catch {}
    Log "worker (node.exe) encerrou (exit code $exitCodeFinal)"

    $rEstado = Set-SyncFinanceiroEstadoWorker -Raiz $raiz -Estado 'Stopped' -GeracaoId $geracaoIdAtual -WorkerPid $pidFinal
    Stop-SyncFinanceiroWorkerTracking -Handle $handleWorkerAtual | Out-Null
    $handleWorkerAtual = $null
    # A PARTIR DAQUI, NUNCA acessar $proc de novo (Process ja descartado).

    if (-not $rEstado.Sucesso) {
      Log "ATENCAO: falha ao persistir Estado=Stopped apos morte natural ($($rEstado.Erro)) - NAO publico ACK Parado mesmo com o sinalizador presente; a proxima geracao reconcilia via PID/StartTimeUtc"
      $geracaoIdAtual = $null
      Start-Sleep -Seconds $backoffSegundos
      continue
    }

    if (Test-SyncFinanceiroFlagPresente -Raiz $raiz) {
      $confirmacao = Confirm-SyncFinanceiroParadaAposSaidaNatural -Raiz $raiz
      Log "parada intencional detectada apos a morte do worker (RequestId=$($confirmacao.RequestIdConfirmado)) - supervisor encerrando, nao reinicia (sinalizador preservado)"
      $geracaoIdAtual = $null
      exit 0
    }

    Log "morte inesperada - reiniciando em ${backoffSegundos}s (proxima volta do loop reivindica uma geracao nova)"
    $geracaoIdAtual = $null
    Start-Sleep -Seconds $backoffSegundos
  } catch {
    try { Log "EXCECAO NAO TRATADA NO SUPERVISOR: $($_.Exception.GetType().FullName): $($_.Exception.Message) | $($_.InvocationInfo.PositionMessage) - reiniciando o loop em 5s" } catch {}
    # CORRECAO FASE 2E (5a/6a rodada): se um handle ja existia quando a
    # excecao aconteceu, tenta desfazer a partida - mas SO libera as
    # variaveis de rastreio se a morte foi CONFIRMADA. Se nao foi, o
    # handle e preservado (nunca descartado em silencio) pra a proxima
    # volta do loop externo retomar a reconciliacao sobre ele - nunca
    # reivindica outra geracao/inicia outro worker enquanto isso nao
    # resolver.
    if ($handleWorkerAtual -and $geracaoIdAtual) {
      try {
        $desfazimento = Invoke-SyncFinanceiroWatchdogDesfazerPartida -Raiz $raiz -GeracaoId $geracaoIdAtual -Handle $handleWorkerAtual -TimeoutSegundos $timeoutConfirmacaoParadaSegundos
        if ($desfazimento.Confirmado) {
          Log "catch externo: handle de partida interrompida desfeito e CONFIRMADO morto (EstadoPersistido=$($desfazimento.EstadoPersistido))"
          $handleWorkerAtual = $null
          $geracaoIdAtual = $null
        } else {
          Log "catch externo: handle de partida interrompida NAO PODE SER CONFIRMADO morto (EstadoPersistido=$($desfazimento.EstadoPersistido)) - handle PRESERVADO pra nova tentativa na proxima volta do loop, NUNCA iniciando outro worker/geracao sobre esta incerteza"
          $handleWorkerAtual = $desfazimento.Handle
        }
      } catch {
        try { Log "catch externo: FALHA ao tentar desfazer o handle de partida interrompida: $($_.Exception.Message) - handle preservado" } catch {}
      }
    } else {
      $handleWorkerAtual = $null
      $geracaoIdAtual = $null
    }
    Start-Sleep -Seconds 5
  }
}
