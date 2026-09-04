# Fase 2E (5a rodada) — testes de scripts/sync-financeiro-control.psm1 e
# verificação estrutural (estática, complementar) de
# watchdog-sync-financeiro.ps1, 4-PARAR.bat e 3-LIGAR.bat.
#
# NUNCA toca a Tarefa Agendada real (VivenzzaSyncFinanceiroLegado), NUNCA
# mata processo real ALHEIO a este arquivo, NUNCA usa WMI real, NUNCA
# precisa de privilégio administrativo, NUNCA chama o cmdlet Get-Job (nem
# em forma "bare" nem filtrada) - achado real da revisão anterior: em
# ambientes com permissões restritas, Get-Job tenta enumerar o repositório
# GLOBAL de jobs, incluindo o adaptador PSScheduledJob
# (%LocalAppData%\Microsoft\Windows\PowerShell\ScheduledJobs), e isso pode
# lançar acesso negado mesmo quando o teste só queria checar os PRÓPRIOS
# jobs de evento. Em vez disso, os testes de integração (seção P4) usam
# SÓ Get-EventSubscriber (que consulta a tabela de assinaturas do próprio
# processo, nunca o repositório global de jobs) e o resultado RICO devolvido
# por Stop-SyncFinanceiroWorkerTracking (que reporta, por chamada, se cada
# etapa de limpeza realmente funcionou, sem precisar reconsultar nada).
#
# ÚNICA EXCEÇÃO à regra de nunca tocar processo real: a seção P4 chama
# Start-SyncFinanceiroWorkerProcesso DE VERDADE, mas SEMPRE com um processo
# DESCARTÁVEL criado pelo próprio teste (powershell.exe rodando um script
# curto e inofensivo, nunca node.exe nem o script real
# sync-financeiro-legado.mjs) — nunca o worker de produção.
#
# Harness mínimo e autocontido (sem framework externo) — mesmo espírito de
# "sem dependência nova" já usado no resto do repo (node:test puro, sem
# jest/mocha).
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot '..\sync-financeiro-control.psm1') -Force

$script:totalTestes = 0
$script:falhas = 0

function Assert-True {
  param($Condicao, [string]$Mensagem)
  if (-not $Condicao) { throw "ASSERT FALHOU: $Mensagem" }
}
function Assert-Equal {
  param($Esperado, $Real, [string]$Mensagem)
  if ($Esperado -ne $Real) { throw "ASSERT FALHOU: $Mensagem (esperado='$Esperado', real='$Real')" }
}
function Teste {
  param([string]$Nome, [scriptblock]$Corpo)
  $script:totalTestes++
  try {
    & $Corpo
    Write-Output "OK   - $Nome"
  } catch {
    $script:falhas++
    Write-Output "FAIL - $Nome"
    Write-Output "       $($_.Exception.Message)"
  }
}

function Novo-RaizTemp {
  $p = Join-Path $env:TEMP ("sfc-test-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $p | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $p 'logs') | Out-Null
  return $p
}

# Extrai o texto de UMA função do módulo/script, do "function Nome {" até o
# próximo "function " de nível superior (ou fim do arquivo) — usado pelos
# testes estruturais que verificam ausência de -ErrorAction SilentlyContinue
# em operações específicas, sem depender de contagem global.
function Get-BlocoDeFuncao {
  param([Parameter(Mandatory)][string]$Texto, [Parameter(Mandatory)][string]$NomeFuncao)
  $m = [regex]::Match($Texto, "(?ms)^function\s+$([regex]::Escape($NomeFuncao))\s*\{")
  if (-not $m.Success) { throw "funcao '$NomeFuncao' nao encontrada no texto" }
  $inicio = $m.Index
  $proximaFuncao = [regex]::Match($Texto.Substring($m.Index + $m.Length), '(?m)^function\s+\S+\s*\{')
  if ($proximaFuncao.Success) {
    return $Texto.Substring($inicio, $m.Length + $proximaFuncao.Index)
  }
  return $Texto.Substring($inicio)
}

# Remove linhas 100% comentario (trimmed comeca com '#') - usado pelos
# testes estruturais abaixo, pra nao confundir uma mencao em PROSA com uma
# chamada de codigo real.
function Remove-LinhasDeComentarioPs1 {
  param([Parameter(Mandatory)][string]$Texto)
  ($Texto -split "`r?`n" | Where-Object { $_.TrimStart() -notmatch '^#' }) -join "`n"
}

$dormirInstantaneo = { param($segundos) } # nunca dorme de verdade nos testes — mantém a suíte rápida

$raizDoRepo = Split-Path -Parent $PSScriptRoot | Split-Path -Parent
$caminhoWatchdog = Join-Path $raizDoRepo 'scripts\watchdog-sync-financeiro.ps1'
$caminhoParar = Join-Path $raizDoRepo '4-PARAR.bat'
$caminhoLigar = Join-Path $raizDoRepo '3-LIGAR.bat'
$caminhoLigarPs1 = Join-Path $raizDoRepo 'scripts\ligar-sync-financeiro.ps1'
$caminhoPararPs1 = Join-Path $raizDoRepo 'scripts\parar-sync-financeiro.ps1'
$caminhoModulo = Join-Path $raizDoRepo 'scripts\sync-financeiro-control.psm1'
$textoModulo = Get-Content -Raw $caminhoModulo
$textoWatchdog = Get-Content -Raw $caminhoWatchdog

$tarefaHabilitada = [pscustomobject]@{ State = 'Ready' }

function Novo-RaizInicializada {
  $raiz = Novo-RaizTemp
  Initialize-SyncFinanceiroEstadoWorker -Raiz $raiz -ConfirmeiQueNenhumWorkerAntigoEstaRodando | Out-Null
  $raiz
}

# CORRECAO FASE 2E (7a rodada): substitui o antigo Set-SyncFinanceiroEstadoWorkerBruto
# (eliminado do modulo - era um bypass PUBLICO de ownership, mesmo que
# protegido por lock). Fixtures de teste agora escrevem o JSON
# DIRETAMENTE no arquivo, sem passar pelo modulo - exatamente como uma
# edicao/corrupcao externa real do arquivo apareceria pro codigo de
# producao. Mesma assinatura do antigo helper pra minimizar o diff dos
# testes que ja usavam esse padrao.
function Set-SyncFinanceiroEstadoFixture {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$Estado,
    [Parameter(Mandatory)][string]$GeracaoId,
    $WorkerPid = $null,
    $StartTimeUtc = $null
  )
  $startTimeUtcTexto = if ($null -ne $StartTimeUtc) { ([datetime]$StartTimeUtc).ToUniversalTime().ToString('o') } else { $null }
  $objeto = [pscustomobject]@{
    ProtocolVersion = 1
    Estado          = $Estado
    GeracaoId       = $GeracaoId
    Pid             = $WorkerPid
    StartTimeUtc    = $startTimeUtcTexto
    AtualizadoEm    = (Get-Date).ToUniversalTime().ToString('o')
  }
  $pasta = Split-Path -Parent (Get-SyncFinanceiroEstadoPath -Raiz $Raiz)
  New-Item -ItemType Directory -Force -Path $pasta | Out-Null
  ($objeto | ConvertTo-Json -Depth 5) | Set-Content -Path (Get-SyncFinanceiroEstadoPath -Raiz $Raiz) -Encoding utf8
}

# ── 1. WMI vazia nunca decide "parado" sozinha ────────────────────────
Teste '1. Invoke-SyncFinanceiroParar NAO confirma sucesso so porque ObterProcessos (WMI) devolve vazio, sem confirmacao real do watchdog' {
  $raiz = Novo-RaizTemp
  try {
    $r = Invoke-SyncFinanceiroParar -Raiz $raiz -TimeoutSegundos 2 -IntervaloSegundos 1 `
      -ObterProcessos { @() } -Iniciar { param($n) } -Dormir $dormirInstantaneo
    Assert-True (-not $r.Sucesso) 'WMI vazio sozinho NUNCA pode bastar pra confirmar parada - so o ack do watchdog pode'
    Assert-Equal 0 $r.ProcessosRestantes 'o campo continua existindo como diagnostico...'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste '1b. Invoke-SyncFinanceiroParar SO confirma sucesso quando o watchdog grava o ack Parado (WMI nunca entra na decisao)' {
  $raiz = Novo-RaizTemp
  try {
    $r = Invoke-SyncFinanceiroParar -Raiz $raiz -TimeoutSegundos 3 -IntervaloSegundos 1 `
      -ObterProcessos { @() } `
      -Iniciar {
      param($n)
      $req = Get-SyncFinanceiroRequestAtual -Raiz $raiz
      Invoke-SyncFinanceiroWatchdogPararEConfirmar -Raiz $raiz -GeracaoId 'watchdog-fake' -RequestId $req.RequestId -WorkerPid 111 `
        -PararProcesso { } -ProcessoSaiu { $true } -TimeoutSegundos 2 -IntervaloSegundos 1 -Dormir $dormirInstantaneo | Out-Null
    } `
      -Dormir $dormirInstantaneo
    Assert-True $r.Sucesso 'precisa confirmar quando o watchdog (fake) grava o ack com o RequestId correto'
    Assert-True (Test-SyncFinanceiroFlagPresente -Raiz $raiz) 'sinalizador precisa permanecer no disco depois da parada confirmada'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── 2. WMI/CommandLine indisponivel nunca pode ser causa de falha do Ligar ─
Teste '2. Invoke-SyncFinanceiroLigar nao aceita mais -ObterProcessos (estrutural: WMI nao faz parte do caminho de decisao do Ligar)' {
  $cmd = Get-Command Invoke-SyncFinanceiroLigar
  Assert-True (-not $cmd.Parameters.ContainsKey('ObterProcessos')) 'Invoke-SyncFinanceiroLigar nao pode mais depender de uma consulta de processos (WMI) pra decidir sucesso'
}
Teste '2b. Invoke-SyncFinanceiroLigar confirma sucesso via ack exato mesmo quando nada relacionado a WMI e chamado' {
  $raiz = Novo-RaizTemp
  try {
    $r = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 3 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $tarefaHabilitada } `
      -Iniciar {
      param($n)
      $req = Get-SyncFinanceiroRequestAtual -Raiz $raiz
      Invoke-SyncFinanceiroWatchdogConfirmarInicio -Raiz $raiz -RequestId $req.RequestId -WorkerPid 222 `
        -AindaVivo { $true } -MinUptimeSegundos 0 -IntervaloSegundos 1 -Dormir $dormirInstantaneo | Out-Null
    } `
      -Dormir $dormirInstantaneo
    Assert-True $r.Sucesso 'precisa confirmar sucesso via ack, sem nenhuma consulta WMI'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── 3. Confirmacao com token correto autoriza sucesso ─────────────────
Teste '3. ack com RequestId correto e Estado esperado autoriza Sucesso (Parar e Ligar)' {
  $raiz = Novo-RaizTemp
  try {
    $estado = @{ requestIdVisto = $null }
    $r = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 3 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $tarefaHabilitada } `
      -Iniciar {
      param($n)
      $req = Get-SyncFinanceiroRequestAtual -Raiz $raiz
      $estado.requestIdVisto = $req.RequestId
      Invoke-SyncFinanceiroWatchdogConfirmarInicio -Raiz $raiz -RequestId $req.RequestId -WorkerPid 333 `
        -AindaVivo { $true } -MinUptimeSegundos 0 -IntervaloSegundos 1 -Dormir $dormirInstantaneo | Out-Null
    } `
      -Dormir $dormirInstantaneo
    Assert-True $r.Sucesso 'precisa confirmar'
    Assert-Equal $estado.requestIdVisto $r.RequestId 'o RequestId que o "watchdog" fake recebeu precisa ser exatamente o que Invoke-SyncFinanceiroLigar gerou'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── 4. Confirmacao antiga (token diferente) e rejeitada ────────────────
Teste '4. Invoke-SyncFinanceiroParar rejeita um ack PARADO com RequestId antigo - so aceita o token gerado nesta chamada' {
  $raiz = Novo-RaizTemp
  try {
    Write-SyncFinanceiroAck -Raiz $raiz -RequestId 'token-de-uma-parada-anterior' -Tipo 'Parar' -Estado 'Parado' -WorkerPid $null
    $r = Invoke-SyncFinanceiroParar -Raiz $raiz -TimeoutSegundos 1 -IntervaloSegundos 1 `
      -Iniciar { param($n) } -Dormir $dormirInstantaneo
    Assert-True (-not $r.Sucesso) 'um ack Parado com RequestId de uma chamada ANTERIOR nao pode bastar - o arquivo existir nao e suficiente'
    Assert-True ($r.RequestId -ne 'token-de-uma-parada-anterior') 'o RequestId desta chamada precisa ser novo, diferente do antigo'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste '4b. Invoke-SyncFinanceiroLigar rejeita um ack RODANDO com RequestId diferente do gerado nesta chamada' {
  $raiz = Novo-RaizTemp
  try {
    Write-SyncFinanceiroAck -Raiz $raiz -RequestId 'token-de-um-ligar-anterior' -Tipo 'Ligar' -Estado 'Rodando' -WorkerPid 999
    $r = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 1 -TimeoutSegundosSeFalhaAoAcionar 1 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $tarefaHabilitada } -Iniciar { param($n) } -Dormir $dormirInstantaneo
    Assert-True (-not $r.Sucesso) 'ack antigo com RequestId diferente nao pode bastar'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── 5. Falha ao remover o sinalizador bloqueia a partida (DEPOIS da
#      validacao da tarefa, que roda primeiro) ─────────────────────────
Teste '5. Invoke-SyncFinanceiroLigar valida a tarefa (chamando -ObterTarefa) ANTES de tentar remover o sinalizador, e aborta ANTES de acionar o Scheduler quando a remocao falha' {
  $raiz = Novo-RaizTemp
  $streamTravando = $null
  try {
    New-SyncFinanceiroFlag -Raiz $raiz -RequestId 'abc'
    $caminhoFlag = Get-SyncFinanceiroFlagPath -Raiz $raiz
    $streamTravando = [System.IO.File]::Open($caminhoFlag, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)

    $chamouObterTarefa = @{ vezes = 0 }
    $chamouIniciar = @{ vezes = 0 }
    $r = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 1 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $chamouObterTarefa.vezes++; $tarefaHabilitada } `
      -Iniciar { param($n) $chamouIniciar.vezes++ } `
      -Dormir $dormirInstantaneo

    Assert-True (-not $r.Sucesso) 'precisa reportar falha quando a remocao do sinalizador nao funciona'
    Assert-True ($r.Erro -match 'remover o sinalizador') 'a mensagem real precisa explicar que foi a remocao do sinalizador que falhou'
    Assert-Equal 1 $chamouObterTarefa.vezes 'a validacao da tarefa (sem mutacao) precisa rodar PRIMEIRO, antes da tentativa de remocao'
    Assert-Equal 0 $chamouIniciar.vezes 'NUNCA pode acionar o Scheduler quando a remocao do sinalizador falhou'
  } finally {
    if ($streamTravando) { $streamTravando.Dispose() }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}

# ── 6. Tarefa desabilitada, acesso negado ───────────────────────────
Teste '6a. Invoke-SyncFinanceiroLigar falha com mensagem real quando a tarefa esta Disabled, SEM tentar habilitar/acionar, sinalizador preservado' {
  $raiz = Novo-RaizTemp
  try {
    New-SyncFinanceiroFlag -Raiz $raiz -RequestId 'flag-pre-existente'
    $chamouIniciar = @{ vezes = 0 }
    $tarefaDesabilitada = [pscustomobject]@{ State = 'Disabled' }
    $r = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 1 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $tarefaDesabilitada } `
      -Iniciar { param($n) $chamouIniciar.vezes++ } `
      -Dormir $dormirInstantaneo
    Assert-True (-not $r.Sucesso) 'nao pode reportar sucesso com a tarefa Disabled'
    Assert-True ($r.Erro -match 'Disabled') 'a mensagem real precisa mencionar o estado Disabled'
    Assert-True ($r.Erro -match '(?i)administrat') 'a mensagem precisa orientar reparo/instalacao administrativa'
    Assert-Equal 0 $chamouIniciar.vezes 'nao pode tentar Start-ScheduledTask numa tarefa que sabe estar Disabled'
    Assert-True (Test-SyncFinanceiroFlagPresente -Raiz $raiz) 'sinalizador precisa continuar presente (nunca chegou a ser removido)'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste '6a-bis. Invoke-SyncFinanceiroLigar (e o modulo inteiro) nao chama mais Enable-ScheduledTask em nenhum caminho (estrutural)' {
  $textoModuloSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoModulo
  Assert-True ($textoModuloSemComentarios -notmatch 'Enable-ScheduledTask') 'o modulo nao pode mais CHAMAR Enable-ScheduledTask em codigo real (mencao em comentario explicando o desenho e permitida)'
}
Teste '6b. Invoke-SyncFinanceiroLigar propaga a mensagem REAL de acesso negado do Start-ScheduledTask (sem elevar/esconder) e restaura o sinalizador quando ninguem confirma' {
  $raiz = Novo-RaizTemp
  try {
    $r = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 1 -TimeoutSegundosSeFalhaAoAcionar 1 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $tarefaHabilitada } `
      -Iniciar { param($n) throw 'Access is denied. (0x80070005)' } `
      -Dormir $dormirInstantaneo
    Assert-True (-not $r.Sucesso) 'acesso negado precisa ser reportado como falha'
    Assert-True ($r.Erro -match 'Access is denied') 'a mensagem real do erro (nao generica) precisa aparecer'
    Assert-True $r.RollbackConfirmado 'como ninguem confirmou, o rollback do sinalizador precisa ter sido confirmado'
    Assert-True (Test-SyncFinanceiroFlagPresente -Raiz $raiz) 'sinalizador precisa estar de volta no disco (rollback)'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── 9. Duas chamadas consecutivas de Parar e de Ligar ──────────────────
Teste '9a. Invoke-SyncFinanceiroParar chamado 2x seguidas (cada uma com um "watchdog" fake respondendo) confirma as duas, sem erro' {
  $raiz = Novo-RaizTemp
  try {
    $watchdogFake = {
      param($n)
      $req = Get-SyncFinanceiroRequestAtual -Raiz $raiz
      Invoke-SyncFinanceiroWatchdogPararEConfirmar -Raiz $raiz -GeracaoId 'watchdog-fake' -RequestId $req.RequestId -WorkerPid 1 `
        -PararProcesso { } -ProcessoSaiu { $true } -TimeoutSegundos 1 -IntervaloSegundos 1 -Dormir $dormirInstantaneo | Out-Null
    }
    $r1 = Invoke-SyncFinanceiroParar -Raiz $raiz -TimeoutSegundos 2 -IntervaloSegundos 1 -Iniciar $watchdogFake -Dormir $dormirInstantaneo
    $r2 = Invoke-SyncFinanceiroParar -Raiz $raiz -TimeoutSegundos 2 -IntervaloSegundos 1 -Iniciar $watchdogFake -Dormir $dormirInstantaneo
    Assert-True $r1.Sucesso 'primeira parada precisa confirmar'
    Assert-True $r2.Sucesso 'segunda parada (idempotente) tambem precisa confirmar'
    Assert-True ($r1.RequestId -ne $r2.RequestId) 'cada chamada precisa gerar um RequestId novo e distinto'
    Assert-True (Test-SyncFinanceiroFlagPresente -Raiz $raiz) 'sinalizador continua presente depois das duas chamadas'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste '9b. Invoke-SyncFinanceiroLigar chamado 2x seguidas nao inicia um segundo worker: a 2a chamada e respondida por um watchdog JA ATIVO que so re-carimba o ack' {
  $raiz = Novo-RaizTemp
  try {
    $estado = @{ pidsIniciados = [System.Collections.Generic.List[int]]::new() }
    $watchdogFakeQueSempreInicia = {
      param($n)
      $req = Get-SyncFinanceiroRequestAtual -Raiz $raiz
      $novoPid = 1000 + $estado.pidsIniciados.Count
      $estado.pidsIniciados.Add($novoPid)
      Invoke-SyncFinanceiroWatchdogConfirmarInicio -Raiz $raiz -RequestId $req.RequestId -WorkerPid $novoPid `
        -AindaVivo { $true } -MinUptimeSegundos 0 -IntervaloSegundos 1 -Dormir $dormirInstantaneo | Out-Null
    }
    $r1 = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 2 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $tarefaHabilitada } -Iniciar $watchdogFakeQueSempreInicia -Dormir $dormirInstantaneo
    Assert-True $r1.Sucesso 'primeira chamada precisa confirmar'
    Assert-True (-not $r1.JaEstavaRodando) 'primeira chamada precisa ser um start de verdade'

    $watchdogFakeJaAtivo = {
      param($n)
      $req = Get-SyncFinanceiroRequestAtual -Raiz $raiz
      Write-SyncFinanceiroAck -Raiz $raiz -RequestId $req.RequestId -Tipo 'Ligar' -Estado 'Rodando' -WorkerPid $estado.pidsIniciados[0]
    }
    $r2 = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 2 -IntervaloSegundos 1 -HeartbeatMaxIdadeSegundos 60 `
      -ObterTarefa { param($n) $tarefaHabilitada } -Iniciar $watchdogFakeJaAtivo -Dormir $dormirInstantaneo
    Assert-True $r2.Sucesso 'segunda chamada (idempotente) precisa confirmar via ack re-carimbado'
    Assert-True $r2.JaEstavaRodando 'segunda chamada precisa classificar corretamente que ja estava rodando'
    Assert-Equal 1 $estado.pidsIniciados.Count 'so pode ter existido 1 "start" real - a segunda chamada nao pode duplicar'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── 10. Nenhum erro relevante e silenciado ─────────────────────────────
Teste '10a. nenhum dos arquivos alterados/criados usa "timeout /t" (dependente do PATH)' {
  foreach ($arquivo in @($caminhoParar, $caminhoLigar, $caminhoWatchdog, $caminhoPararPs1, $caminhoLigarPs1, $caminhoModulo)) {
    $texto = Get-Content -Raw $arquivo
    Assert-True ($texto -notmatch '(?i)timeout\s*/t') "arquivo nao pode usar 'timeout /t': $arquivo"
  }
}
Teste '10b. 4-PARAR.bat nao chama schtasks /end nem /change /disable, nem engole erro com >nul 2>&1 nessas chamadas' {
  $linhasDeComando = Get-Content $caminhoParar | Where-Object { $_.TrimStart() -notmatch '^REM' -and $_.TrimStart() -notmatch '^::' }
  $textoComandos = $linhasDeComando -join "`n"
  Assert-True ($textoComandos -notmatch '(?i)schtasks\s*/end') '4-PARAR.bat nao pode mais EXECUTAR schtasks /end'
  Assert-True ($textoComandos -notmatch '(?i)schtasks\s*/change') '4-PARAR.bat nao pode mais EXECUTAR schtasks /change /disable'
}
Teste '10c. Remove-SyncFinanceiroFlag nao usa -ErrorAction SilentlyContinue (a remocao do sinalizador precisa de erro real, nunca escondido)' {
  $bloco = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Remove-SyncFinanceiroFlag'
  Assert-True ($bloco -notmatch 'SilentlyContinue') 'Remove-SyncFinanceiroFlag nao pode esconder nenhum erro de remocao'
}
Teste '10d. Write-SyncFinanceiroJsonArquivo (escrita de request/ack/heartbeat/sinalizador/estado) nao usa -ErrorAction SilentlyContinue' {
  $bloco = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Write-SyncFinanceiroJsonArquivo'
  Assert-True ($bloco -notmatch 'SilentlyContinue') 'a escrita atomica de qualquer arquivo de protocolo precisa propagar erro real'
  Assert-True ($bloco -match 'ErrorAction\s+Stop') 'a escrita precisa usar -ErrorAction Stop explicitamente'
}
Teste '10e. Invoke-SyncFinanceiroLigar propaga a mensagem real de erro de Start-ScheduledTask e do estado Disabled (sem mensagens genericas)' {
  $raiz = Novo-RaizTemp
  try {
    $r = Invoke-SyncFinanceiroLigar -Raiz $raiz -TimeoutSegundos 1 -TimeoutSegundosSeFalhaAoAcionar 1 -IntervaloSegundos 1 `
      -ObterTarefa { param($n) $tarefaHabilitada } `
      -Iniciar { param($n) throw 'mensagem bem especifica e incomum do erro de Start-ScheduledTask' } `
      -Dormir $dormirInstantaneo
    Assert-True ($r.Erro -match 'mensagem bem especifica e incomum') 'a mensagem exata do erro real precisa aparecer, nunca uma generica'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste '10f. Invoke-SyncFinanceiroLimpezaLegadoWmi (diagnostico) nao usa -ErrorAction SilentlyContinue nas consultas CIM' {
  $bloco = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Invoke-SyncFinanceiroLimpezaLegadoWmi'
  Assert-True ($bloco -notmatch 'SilentlyContinue') 'as consultas CIM dentro de Invoke-SyncFinanceiroLimpezaLegadoWmi precisam usar -ErrorAction Stop, nunca SilentlyContinue'
  Assert-True ($bloco -match 'ErrorAction\s+Stop') 'Invoke-SyncFinanceiroLimpezaLegadoWmi precisa usar -ErrorAction Stop explicitamente nas consultas CIM'
}
Teste '10g. Set-SyncFinanceiroEstadoWorker nao usa -ErrorAction SilentlyContinue na escrita' {
  $bloco = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Set-SyncFinanceiroEstadoWorker'
  Assert-True ($bloco -notmatch 'SilentlyContinue') 'a escrita da maquina de estados precisa propagar erro real'
}

# ── Testes complementares mantidos (ainda validos, estaticos) ──────────
Teste '11. ligar-sync-financeiro.ps1: mensagem final so aparece depois de checar $resultado.Sucesso (estatico)' {
  $texto = Get-Content -Raw $caminhoLigarPs1
  Assert-True ($texto -match 'if\s*\(\$resultado\.Sucesso') 'ligar-sync-financeiro.ps1 precisa checar $resultado.Sucesso antes de imprimir sucesso'
}
Teste '12. parar-sync-financeiro.ps1: mensagem "desligada" so aparece dentro do bloco de sucesso (estatico)' {
  $texto = Get-Content -Raw $caminhoPararPs1
  Assert-True ($texto -match '(?s)if\s*\(\$resultado\.Sucesso\)\s*\{[^}]*desligada') 'a mensagem de sucesso precisa estar dentro do bloco "if ($resultado.Sucesso)"'
}
Teste '13. 3-LIGAR.bat: "PRONTO" so pode aparecer depois do "if errorlevel 1 goto erro_ligar" (estatico)' {
  $texto = Get-Content -Raw $caminhoLigar
  $posicaoGoto = $texto.IndexOf('if errorlevel 1 goto erro_ligar')
  $posicaoPronto = $texto.IndexOf('PRONTO')
  Assert-True ($posicaoGoto -ge 0) '3-LIGAR.bat precisa checar o errorlevel do script de ligar'
  Assert-True ($posicaoGoto -lt $posicaoPronto) '"PRONTO" so pode vir depois da checagem de erro'
}

# ═══════════════════════════════════════════════════════════════════════
# ── REVISAO 4 (5a rodada) — máquina de estados, partida transacional ───
# ═══════════════════════════════════════════════════════════════════════

# ── E: leitura/escrita da máquina de estados ────────────────────────────
Teste 'E1. Get-SyncFinanceiroEstadoWorkerAtual: arquivo ausente vira Estado=Unknown, nunca autoriza start' {
  $raiz = Novo-RaizTemp
  try {
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Unknown' $e.Estado 'ausencia precisa virar Unknown'
    Assert-True ($e.MotivoIncerto -match '(?i)ausente') 'motivo precisa mencionar ausencia'
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'Unknown nunca autoriza start'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E2. Get-SyncFinanceiroEstadoWorkerAtual: arquivo corrompido (JSON invalido) vira Estado=Unknown, nunca bootstrap automatico' {
  $raiz = Novo-RaizTemp
  try {
    Set-Content -Path (Get-SyncFinanceiroEstadoPath -Raiz $raiz) -Value '{ isso nao e json valido ]]]' -Encoding utf8
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Unknown' $e.Estado 'corrupcao precisa virar Unknown'
    Assert-True ($e.MotivoIncerto -match '(?i)corromp') 'motivo precisa mencionar corrupcao'
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'Unknown por corrupcao nunca vira bootstrap automatico'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E3. Get-SyncFinanceiroEstadoWorkerAtual: Running sem Pid/StartTimeUtc/GeracaoId vira Estado=Unknown' {
  $raiz = Novo-RaizTemp
  try {
    # Write-SyncFinanceiroJsonArquivo e interna (nao exportada) - escreve o
    # JSON bruto diretamente, so pra este teste conseguir montar um Running
    # deliberadamente incompleto.
    $objeto = [pscustomobject]@{ ProtocolVersion = 1; Estado = 'Running'; GeracaoId = $null; Pid = $null; StartTimeUtc = $null; AtualizadoEm = (Get-Date).ToString('o') }
    ($objeto | ConvertTo-Json -Depth 5) | Set-Content -Path (Get-SyncFinanceiroEstadoPath -Raiz $raiz) -Encoding utf8
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Unknown' $e.Estado 'Running incompleto precisa virar Unknown'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E4. Initialize-SyncFinanceiroEstadoWorker: recusa rodar sem -ConfirmeiQueNenhumWorkerAntigoEstaRodando, nao cria arquivo' {
  $raiz = Novo-RaizTemp
  try {
    $r = Initialize-SyncFinanceiroEstadoWorker -Raiz $raiz
    Assert-True (-not $r.Sucesso) 'sem confirmacao precisa recusar'
    Assert-True (-not (Test-Path (Get-SyncFinanceiroEstadoPath -Raiz $raiz))) 'nenhum arquivo pode ser criado sem a confirmacao'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E5. Initialize-SyncFinanceiroEstadoWorker: com confirmacao, grava Estado=Stopped' {
  $raiz = Novo-RaizTemp
  try {
    $r = Initialize-SyncFinanceiroEstadoWorker -Raiz $raiz -ConfirmeiQueNenhumWorkerAntigoEstaRodando
    Assert-True $r.Sucesso 'com confirmacao precisa funcionar'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'bootstrap precisa gravar Stopped'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E6. Initialize-SyncFinanceiroEstadoWorker: bootstrap permitido UMA UNICA vez - recusa se ja existe arquivo (mesmo Stopped valido)' {
  $raiz = Novo-RaizInicializada
  try {
    $r2 = Initialize-SyncFinanceiroEstadoWorker -Raiz $raiz -ConfirmeiQueNenhumWorkerAntigoEstaRodando
    Assert-True (-not $r2.Sucesso) '2a chamada precisa ser recusada'
    Assert-True ($r2.Erro -match '(?i)ja existe') 'motivo precisa explicar que ja existe um arquivo'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E7. Estado=Stopped autoriza DeveIniciarWorker=true SEM chamar ObterProcessoPorId/EncerrarProcesso, e JA REIVINDICA Starting atomicamente (Reivindicado=true, estado no disco reflete a nova geracao)' {
  $raiz = Novo-RaizInicializada
  try {
    $chamouObter = @{ n = 0 }; $chamouEncerrar = @{ n = 0 }
    $geracaoId = [guid]::NewGuid().ToString()
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoId `
      -ObterProcessoPorId { param($ProcessId) $chamouObter.n++; $null } `
      -EncerrarProcesso { param($ProcessId) $chamouEncerrar.n++ }
    Assert-True $d.DeveIniciarWorker 'Stopped precisa autorizar start'
    Assert-True $d.Reivindicado 'a reivindicacao de Starting precisa ter acontecido ATOMICAMENTE dentro desta mesma chamada'
    Assert-Equal 0 $chamouObter.n 'Stopped nao precisa consultar processo nenhum'
    Assert-Equal 0 $chamouEncerrar.n 'Stopped nao precisa encerrar processo nenhum'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Starting' $e.Estado 'Starting precisa estar persistido no disco - a reivindicacao nao e so no valor de retorno'
    Assert-Equal $geracaoId $e.GeracaoId 'o dono precisa ser exatamente o GeracaoId passado'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E8. Estado Starting deixado por uma geracao INTERROMPIDA bloqueia nova partida' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Starting' -GeracaoId 'geracao-interrompida' | Out-Null
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'Starting de outra geracao nunca autoriza start automatico'
    Assert-True $d.EstadoIncerto 'precisa reportar EstadoIncerto'
    Assert-True ($d.MotivoBloqueio -match 'Starting') 'motivo precisa mencionar Starting'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E9. Estado Stopping bloqueia nova partida' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Stopping' -GeracaoId 'geracao-parando' | Out-Null
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'Stopping nunca autoriza start automatico'
    Assert-True $d.EstadoIncerto 'precisa reportar EstadoIncerto'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E10. Parada normal persiste Estado=Stopped SEM remover o arquivo (Set-SyncFinanceiroEstadoWorker nunca apaga, so atualiza)' {
  $raiz = Novo-RaizInicializada
  try {
    $caminho = Get-SyncFinanceiroEstadoPath -Raiz $raiz
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 111 -StartTimeUtc (Get-Date) | Out-Null
    $r = Set-SyncFinanceiroEstadoWorker -Raiz $raiz -Estado 'Stopped' -GeracaoId 'g1'
    Assert-True $r.Sucesso 'transicao pra Stopped da mesma geracao precisa funcionar'
    Assert-True (Test-Path $caminho) 'o ARQUIVO precisa continuar existindo apos a parada'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'conteudo precisa refletir Stopped'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E11. Geracao ANTIGA tentando sobrescrever o estado de uma geracao NOVA e recusada (ownership)' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Starting' -GeracaoId 'geracao-nova' | Out-Null
    $rAntiga = Set-SyncFinanceiroEstadoWorker -Raiz $raiz -Estado 'Running' -GeracaoId 'geracao-antiga' -WorkerPid 999 -StartTimeUtc (Get-Date)
    Assert-True (-not $rAntiga.Sucesso) 'geracao antiga nao pode escrever sobre o estado de uma geracao nova'
    Assert-True ($rAntiga.Erro -match '(?i)outra geracao') 'motivo precisa explicar o conflito de dono'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'geracao-nova' $e.GeracaoId 'o estado precisa continuar pertencendo a geracao NOVA, intocado'
    Assert-Equal 'Starting' $e.Estado 'o Estado tambem precisa continuar intocado'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'E12. Comparacao de identidade usa TICKS EXATOS em UTC, sem tolerancia - 1 segundo de diferenca ja conta como PID reaproveitado' {
  $raiz = Novo-RaizInicializada
  try {
    $stRegistrado = [datetime]'2026-01-01T10:00:00Z'
    $stUmSegundoDepois = $stRegistrado.AddSeconds(1)
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 4242 -StartTimeUtc $stRegistrado | Out-Null
    $chamouEncerrar = @{ n = 0 }
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) `
      -ObterProcessoPorId { param($ProcessId) [pscustomobject]@{ Id = $ProcessId; StartTime = $stUmSegundoDepois } } `
      -EncerrarProcesso { param($ProcessId) $chamouEncerrar.n++ }
    Assert-True $d.DeveIniciarWorker '1 segundo de diferenca precisa ser tratado como PID reaproveitado (outro processo), nao "mesmo processo com folga de arredondamento"'
    Assert-Equal 0 $chamouEncerrar.n 'nunca pode tentar encerrar um processo que a comparacao exata mostrou ser outro'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── R: reconciliação de Estado=Running ──────────────────────────────────
Teste 'R1. Reconciliar Running: PID nao existe mais - confirma seguro, NUNCA chama EncerrarProcesso' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 999999 -StartTimeUtc (Get-Date) | Out-Null
    $chamouEncerrar = @{ n = 0 }
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -ObterProcessoPorId { param($ProcessId) $null } -EncerrarProcesso { param($ProcessId) $chamouEncerrar.n++ }
    Assert-True $d.DeveIniciarWorker 'PID inexistente confirma seguro'
    Assert-Equal 0 $chamouEncerrar.n 'nao ha nada pra encerrar'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'R2. Reconciliar Running: PID existe mas com StartTimeUtc diferente (reaproveitado) - confirma seguro SEM tentar encerrar o processo errado' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 4242 -StartTimeUtc ([datetime]'2020-01-01T00:00:00Z') | Out-Null
    $processoDiferente = [pscustomobject]@{ Id = 4242; StartTime = (Get-Date) }
    $chamouEncerrar = @{ n = 0 }
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -ObterProcessoPorId { param($ProcessId) $processoDiferente } -EncerrarProcesso { param($ProcessId) $chamouEncerrar.n++ }
    Assert-True $d.DeveIniciarWorker 'StartTime diferente = outro processo, confirma seguro'
    Assert-Equal 0 $chamouEncerrar.n 'NUNCA pode tentar encerrar um processo que nao e o que foi registrado (evita matar processo errado)'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'R3. Reconciliar Running: mesma identidade EXATA (realmente vivo) - encerra e reconfirma antes de autorizar' {
  $raiz = Novo-RaizInicializada
  try {
    $stEsperado = [datetime]'2026-01-01T10:00:00Z'
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 5555 -StartTimeUtc $stEsperado | Out-Null
    $estadoProc = @{ vivo = $true }
    $chamouEncerrar = @{ n = 0 }
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -IntervaloReconfirmacaoSegundos 1 -Dormir $dormirInstantaneo `
      -ObterProcessoPorId { param($ProcessId) if ($estadoProc.vivo) { [pscustomobject]@{ Id = $ProcessId; StartTime = $stEsperado } } else { $null } } `
      -EncerrarProcesso { param($ProcessId) $chamouEncerrar.n++; $estadoProc.vivo = $false }
    Assert-Equal 1 $chamouEncerrar.n 'precisa tentar encerrar o processo REALMENTE vivo'
    Assert-True $d.DeveIniciarWorker 'apos reconfirmar via a mesma identidade que sumiu, autoriza'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'R4. Reconciliar Running: apos encerrar, processo AINDA aparece (mesma identidade) - nao autoriza (nunca confirma por omissao)' {
  $raiz = Novo-RaizInicializada
  try {
    $stEsperado = [datetime]'2026-01-01T10:00:00Z'
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 6666 -StartTimeUtc $stEsperado | Out-Null
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -TimeoutReconfirmacaoSegundos 2 -IntervaloReconfirmacaoSegundos 1 -Dormir $dormirInstantaneo `
      -ObterProcessoPorId { param($ProcessId) [pscustomobject]@{ Id = $ProcessId; StartTime = $stEsperado } } `
      -EncerrarProcesso { param($ProcessId) }
    Assert-True (-not $d.DeveIniciarWorker) 'nao pode autorizar se o processo identificado continua vivo apos a tentativa de encerrar'
    Assert-True $d.EstadoIncerto 'precisa reportar incerto'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'R5. Reconciliar Running: falha ao CONSULTAR o processo - nao autoriza (nunca confirma por omissao)' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 7777 -StartTimeUtc (Get-Date) | Out-Null
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -ObterProcessoPorId { param($ProcessId) throw 'consulta falhou de verdade' }
    Assert-True (-not $d.DeveIniciarWorker) 'falha real na consulta nao pode virar sucesso'
    Assert-True ($d.MotivoBloqueio -match 'consulta falhou de verdade') 'mensagem real precisa aparecer'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'R6. Reconciliar Running: falha ao ENCERRAR o processo - nao autoriza' {
  $raiz = Novo-RaizInicializada
  try {
    $stEsperado = Get-Date
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 8888 -StartTimeUtc $stEsperado | Out-Null
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) `
      -ObterProcessoPorId { param($ProcessId) [pscustomobject]@{ Id = $ProcessId; StartTime = $stEsperado } } `
      -EncerrarProcesso { param($ProcessId) throw 'acesso negado ao encerrar' }
    Assert-True (-not $d.DeveIniciarWorker) 'falha real ao encerrar nao pode virar sucesso'
    Assert-True ($d.MotivoBloqueio -match 'acesso negado ao encerrar') 'mensagem real precisa aparecer'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── RS: Running reconciliado POSITIVAMENTE + sinalizador presente
#      (Fase 2E, 7ª rodada) ─────────────────────────────────────────────
Teste 'RS1. Invoke-SyncFinanceiroWatchdogInicio: Running reconciliado positivamente (PID sumiu) + sinalizador presente - persiste Estado=Stopped ANTES do ack/heartbeat de Parado' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'geracao-morta' -WorkerPid 424242 -StartTimeUtc (Get-Date)
    New-SyncFinanceiroFlag -Raiz $raiz -RequestId 'req-rs1'
    $geracaoAtual = [guid]::NewGuid().ToString()
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoAtual -ObterProcessoPorId { param($ProcessId) $null }

    Assert-True (-not $d.DeveIniciarWorker) 'sinalizador presente nunca autoriza start'
    Assert-True (-not $d.EstadoIncerto) 'reconciliacao positiva + persistencia OK nao pode ser incerta'
    Assert-Equal 'req-rs1' $d.RequestIdConfirmado 'precisa confirmar o RequestId correto'

    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'a maquina de estados PRECISA refletir Stopped - nao pode continuar dizendo Running sobre um worker ja confirmado morto'
    Assert-Equal $geracaoAtual $e.GeracaoId 'quem fechou o registro (esta geracao, que provou a morte) precisa aparecer como dono'

    $ack = Get-SyncFinanceiroAckAtual -Raiz $raiz
    Assert-Equal 'Parado' $ack.Estado 'ack precisa confirmar Parado'
    Assert-Equal 'req-rs1' $ack.RequestId 'RequestId do ack precisa ser exato'
    $hb = Get-SyncFinanceiroHeartbeatAtual -Raiz $raiz
    Assert-Equal 'Parado' $hb.Estado 'heartbeat precisa confirmar Parado'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'RS2. Invoke-SyncFinanceiroWatchdogInicio: Running reconciliado positivamente + sinalizador presente, mas FALHA ao persistir Stopped (arquivo travado) - NAO publica ack/heartbeat de sucesso, devolve EstadoIncerto=true com o erro real' {
  $raiz = Novo-RaizInicializada
  $streamTravando = $null
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'geracao-morta' -WorkerPid 535353 -StartTimeUtc (Get-Date)
    New-SyncFinanceiroFlag -Raiz $raiz -RequestId 'req-rs2'
    $caminhoEstado = Get-SyncFinanceiroEstadoPath -Raiz $raiz
    # Trava o arquivo de ESTADO (nao o de heartbeat/ack) DENTRO do proprio
    # -ObterProcessoPorId - esse hook e sempre chamado durante a
    # reconciliacao (mesmo no caminho "PID sumiu", que NAO chama
    # -EncerrarProcesso), entao e o unico lugar injetavel disponivel pra
    # forcar a escrita de Stopped (que acontece DEPOIS da reconciliacao,
    # ainda sob o mesmo lock) a falhar de verdade.
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -ObterProcessoPorId {
      param($ProcessId)
      $script:streamTravandoRS2 = [System.IO.File]::Open($caminhoEstado, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
      $null
    }
    $streamTravando = $script:streamTravandoRS2
    $script:streamTravandoRS2 = $null

    Assert-True (-not $d.DeveIniciarWorker) 'nunca pode autorizar start quando a persistencia falhou'
    Assert-True $d.EstadoIncerto 'precisa reportar EstadoIncerto quando a persistencia de Stopped falha'
    Assert-True ($d.MotivoBloqueio -match '(?i)FALHA ao persistir Estado=Stopped') 'o erro real precisa mencionar a falha de persistencia'
    Assert-True ((Get-SyncFinanceiroAckAtual -Raiz $raiz) -eq $null) 'NENHUM ack pode existir - a persistencia falhou ANTES de qualquer heartbeat/ACK'
    Assert-True ((Get-SyncFinanceiroHeartbeatAtual -Raiz $raiz) -eq $null) 'NENHUM heartbeat pode existir'

    if ($streamTravando) { $streamTravando.Dispose(); $streamTravando = $null }
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Running' $e.Estado 'o arquivo original (Running) precisa continuar intacto - a escrita falhou antes de completar (Move-Item nunca substituiu o arquivo real)'
  } finally {
    if ($streamTravando) { try { $streamTravando.Dispose() } catch {} }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}

# ── P (retentativas) ─────────────────────────────────────────────────
Teste 'P1. Invoke-SyncFinanceiroWatchdogInicioComRetentativas resolve assim que um problema transiente se resolve' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 100 -StartTimeUtc (Get-Date) | Out-Null
    $tentativas = @{ n = 0 }
    $d = Invoke-SyncFinanceiroWatchdogInicioComRetentativas -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -MaxTentativas 5 -IntervaloSegundos 1 -Dormir $dormirInstantaneo `
      -ObterProcessoPorId {
      param($ProcessId)
      $tentativas.n++
      if ($tentativas.n -lt 3) { throw 'transiente' }
      $null
    }
    Assert-Equal 3 $tentativas.n 'precisa parar assim que confirmar (nao esgotar as 5 disponiveis)'
    Assert-True $d.DeveIniciarWorker 'apos resolver, autoriza start'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'P2. Invoke-SyncFinanceiroWatchdogInicioComRetentativas esgota tentativas e devolve MotivoBloqueio, sem autorizar start' {
  $raiz = Novo-RaizInicializada
  try {
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId 'g1' -WorkerPid 100 -StartTimeUtc (Get-Date) | Out-Null
    $tentativas = @{ n = 0 }
    $d = Invoke-SyncFinanceiroWatchdogInicioComRetentativas -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString()) -MaxTentativas 3 -IntervaloSegundos 1 -Dormir $dormirInstantaneo `
      -ObterProcessoPorId { param($ProcessId) $tentativas.n++; throw 'sempre falha' }
    Assert-Equal 3 $tentativas.n 'precisa tentar exatamente MaxTentativas vezes'
    Assert-True (-not $d.DeveIniciarWorker) 'nunca autoriza apos esgotar sem resolver'
    Assert-True ($d.MotivoBloqueio -match 'sempre falha') 'motivo real precisa aparecer'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── T: partida transacional ─────────────────────────────────────────────
function New-ScriptDescartavelCodificado {
  param([string]$Codigo)
  [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($Codigo))
}
function New-ArgumentosPowerShellDescartavel {
  param([string]$Codigo)
  "-NoProfile -NonInteractive -EncodedCommand $(New-ScriptDescartavelCodificado -Codigo $Codigo)"
}
function Wait-ProcessoSair {
  param($Processo, [int]$TimeoutSegundos = 15)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while (-not $Processo.HasExited -and $sw.Elapsed.TotalSeconds -lt $TimeoutSegundos) { Start-Sleep -Milliseconds 100; $Processo.Refresh() }
  $Processo.HasExited
}

Teste 'T1. Invoke-SyncFinanceiroWatchdogPartidaTransacional: sucesso completo com processo REAL grava Running com PID/StartTimeUtc/GeracaoId corretos' {
  $raiz = Novo-RaizInicializada
  $logPath = Join-Path $raiz 'worker-t1.log'
  $handleLimpo = $false
  try {
    $geracaoId = [guid]::NewGuid().ToString()
    # PRE-CONDICAO (Fase 2E, 6a rodada): Starting precisa ter sido
    # reivindicado ATOMICAMENTE por Invoke-SyncFinanceiroWatchdogInicio
    # antes de chamar a partida transacional - ela nao reivindica mais
    # sozinha.
    $claim = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoId
    Assert-True $claim.DeveIniciarWorker 'precondicao do teste: a reivindicacao atomica precisa ter funcionado'
    $r = Invoke-SyncFinanceiroWatchdogPartidaTransacional -Raiz $raiz -GeracaoId $geracaoId -IniciarProcesso {
      Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos (New-ArgumentosPowerShellDescartavel -Codigo 'Start-Sleep -Seconds 20') -WorkingDirectory $raiz -LogPath $logPath
    }
    Assert-True $r.Sucesso 'partida precisa funcionar'
    Assert-True ($r.Handle.Processo.Id -gt 0) 'handle precisa ter PID real'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Running' $e.Estado 'estado precisa ser Running'
    Assert-Equal $r.Handle.Processo.Id $e.Pid 'PID gravado precisa bater com o processo real'
    Assert-Equal $geracaoId $e.GeracaoId 'GeracaoId gravado precisa bater'
    Assert-True ($null -ne $e.StartTimeUtc) 'StartTimeUtc precisa estar presente'

    Stop-Process -Id $r.Handle.Processo.Id -Force
    Wait-ProcessoSair -Processo $r.Handle.Processo | Out-Null
    Stop-SyncFinanceiroWorkerTracking -Handle $r.Handle | Out-Null
    $handleLimpo = $true
  } finally {
    if (-not $handleLimpo) { try { Get-Process -Id $r.Handle.Processo.Id -ErrorAction Stop | Stop-Process -Force } catch {} }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}

Teste 'T2. Invoke-SyncFinanceiroWatchdogPartidaTransacional: falha ao gravar Running (arquivo de estado travado) desfaz por completo - mata o processo REAL, confirma, nao reentra numa 2a partida' {
  $raiz = Novo-RaizInicializada
  $logPath = Join-Path $raiz 'worker-t2.log'
  # Hashtable mutavel capturada por referencia - NAO usar $script: aqui
  # (mesmo achado das rodadas anteriores: $script: dentro de um scriptblock
  # aninhado escreve no escopo do ARQUIVO .ps1, nao no escopo local deste
  # Teste{}, entao nunca conectaria de volta com uma variavel local).
  $estado = @{ stream = $null; pidCriado = $null; chamadasIniciar = 0 }
  try {
    $geracaoId = [guid]::NewGuid().ToString()
    $claim = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoId
    Assert-True $claim.DeveIniciarWorker 'precondicao do teste: a reivindicacao atomica precisa ter funcionado'
    $caminhoEstado = Get-SyncFinanceiroEstadoPath -Raiz $raiz
    $r = Invoke-SyncFinanceiroWatchdogPartidaTransacional -Raiz $raiz -GeracaoId $geracaoId -IniciarProcesso {
      $estado.chamadasIniciar++
      $h = Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos (New-ArgumentosPowerShellDescartavel -Codigo 'Start-Sleep -Seconds 20') -WorkingDirectory $raiz -LogPath $logPath
      $estado.pidCriado = $h.Processo.Id
      # Trava o arquivo de estado AGORA (depois que o processo real ja
      # nasceu) pra forcar a escrita de Running, mais adiante na mesma
      # transacao, a falhar de verdade - simula exatamente "falha ao
      # gravar Running depois de o processo nascer".
      $estado.stream = [System.IO.File]::Open($caminhoEstado, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
      $h
    } -TimeoutDesfazimentoSegundos 10 -IntervaloSegundos 1 -Dormir $dormirInstantaneo

    Assert-Equal 1 $estado.chamadasIniciar 'IniciarProcesso so pode ter sido chamado 1 vez - nunca uma 2a partida sobre a falha'
    Assert-True (-not $r.Sucesso) 'a transacao inteira precisa reportar falha'
    Assert-True ($r.Erro -match 'Running') 'motivo precisa mencionar a falha ao gravar Running'
    Assert-True ($null -eq $r.Handle) 'nenhum handle "vivo" pode ser devolvido de uma partida desfeita'

    if ($estado.stream) { $estado.stream.Dispose(); $estado.stream = $null }

    # O desfazimento (dentro da propria chamada acima) ja devia ter
    # confirmado o processo morto antes de devolver - reconfirma aqui, de
    # fora, como verificacao INDEPENDENTE (nao ficou orfao).
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $aindaVivo = $true
    while ($aindaVivo -and $sw.Elapsed.TotalSeconds -lt 10) {
      $aindaVivo = (Get-Process -Id $estado.pidCriado -ErrorAction SilentlyContinue) -ne $null
      if ($aindaVivo) { Start-Sleep -Milliseconds 100 }
    }
    Assert-True (-not $aindaVivo) 'o processo REAL criado durante a partida precisa ter sido encerrado pelo desfazimento (nao pode ficar orfao)'
  } finally {
    if ($estado.stream) { $estado.stream.Dispose() }
    if ($estado.pidCriado) { try { Get-Process -Id $estado.pidCriado -ErrorAction Stop | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}

Teste 'T3. Invoke-SyncFinanceiroWatchdogPartidaTransacional: excecao ao obter StartTime desfaz a partida (processo fake, sem tocar processo real)' {
  $raiz = Novo-RaizInicializada
  try {
    $geracaoId = [guid]::NewGuid().ToString()
    $claim = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoId
    Assert-True $claim.DeveIniciarWorker 'precondicao do teste: a reivindicacao atomica precisa ter funcionado'
    $chamouParar = @{ n = 0 }
    $procFake = New-Object psobject
    $procFake | Add-Member -MemberType NoteProperty -Name Id -Value 4242
    $procFake | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw 'falha ao obter StartTime' }
    $procFake | Add-Member -MemberType NoteProperty -Name HasExited -Value $true
    $handleFake = [pscustomobject]@{ Processo = $procFake; Writer = $null; AssinaturaSaida = $null; AssinaturaErro = $null }

    $r = Invoke-SyncFinanceiroWatchdogPartidaTransacional -Raiz $raiz -GeracaoId $geracaoId -IniciarProcesso { $handleFake } `
      -PararProcesso { param($H) $chamouParar.n++ } `
      -ConfirmarSaida { param($H) $true } `
      -DrenarSaida { param($H) } `
      -LiberarTracking { param($H) } `
      -TimeoutDesfazimentoSegundos 2 -IntervaloSegundos 1 -Dormir $dormirInstantaneo

    Assert-True (-not $r.Sucesso) 'precisa reportar falha'
    Assert-True ($r.Erro -match 'StartTime') 'motivo precisa mencionar a falha ao obter StartTime'
    Assert-Equal 1 $chamouParar.n 'precisa ter tentado encerrar o processo (o processo JA EXISTIA nesse ponto)'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'ConfirmarSaida=true -> desfazimento confirma Stopped'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

Teste 'T4. Invoke-SyncFinanceiroWatchdogPartidaTransacional: heartbeat falha DEPOIS de Running (processo REAL) - nenhum ACK Rodando fica disponivel, o Node e encerrado, e o estado final e persistido corretamente' {
  $raiz = Novo-RaizInicializada
  $logPath = Join-Path $raiz 'worker-t4.log'
  try {
    $geracaoId = [guid]::NewGuid().ToString()
    $claim = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoId
    Assert-True $claim.DeveIniciarWorker 'precondicao do teste: a reivindicacao atomica precisa ter funcionado'

    $estado = @{ pidCriado = $null }
    # -PosRunning simula EXATAMENTE o cenario do requisito: o processo REAL
    # ja esta de pe (Estado=Running ja persistido nesse ponto) e a proxima
    # operacao falivel (gravar o heartbeat) lanca - nunca chega a gravar o
    # ACK Rodando (que so aconteceria DEPOIS do heartbeat, ver
    # Invoke-SyncFinanceiroWatchdogConfirmarInicio).
    $r = Invoke-SyncFinanceiroWatchdogPartidaTransacional -Raiz $raiz -GeracaoId $geracaoId -IniciarProcesso {
      $h = Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos (New-ArgumentosPowerShellDescartavel -Codigo 'Start-Sleep -Seconds 20') -WorkingDirectory $raiz -LogPath $logPath
      $estado.pidCriado = $h.Processo.Id
      $h
    } -PosRunning { param($H) throw 'falha simulada ao gravar heartbeat/ACK' } `
      -TimeoutDesfazimentoSegundos 10 -IntervaloSegundos 1 -Dormir $dormirInstantaneo

    Assert-True (-not $r.Sucesso) 'precisa reportar falha'
    Assert-True ($r.Erro -match 'heartbeat/ACK') 'motivo precisa mencionar a falha do PosRunning'
    Assert-True ((Get-SyncFinanceiroAckAtual -Raiz $raiz) -eq $null) 'NENHUM ack Rodando pode existir - a falha aconteceu antes do ACK (que so seria gravado DEPOIS do heartbeat)'
    Assert-True ((Get-SyncFinanceiroHeartbeatAtual -Raiz $raiz) -eq $null) 'o heartbeat tambem nao pode existir - foi ELE que "falhou" neste cenario'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'desfazimento precisa ter confirmado Stopped'

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $aindaVivo = $true
    while ($aindaVivo -and $sw.Elapsed.TotalSeconds -lt 10) {
      $aindaVivo = (Get-Process -Id $estado.pidCriado -ErrorAction SilentlyContinue) -ne $null
      if ($aindaVivo) { Start-Sleep -Milliseconds 100 }
    }
    Assert-True (-not $aindaVivo) 'o processo Node REAL precisa ter sido encerrado pelo desfazimento'
  } finally {
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}

Teste 'T5. Invoke-SyncFinanceiroWatchdogPartidaTransacional: falha ao INICIAR o processo (nada nasceu) grava Stopped, sem tentar desfazer um handle inexistente' {
  $raiz = Novo-RaizInicializada
  try {
    $geracaoId = [guid]::NewGuid().ToString()
    $claim = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoId
    Assert-True $claim.DeveIniciarWorker 'precondicao do teste: a reivindicacao atomica precisa ter funcionado'
    $r = Invoke-SyncFinanceiroWatchdogPartidaTransacional -Raiz $raiz -GeracaoId $geracaoId -IniciarProcesso { throw 'falha real ao iniciar o processo' }
    Assert-True (-not $r.Sucesso) 'precisa reportar falha'
    Assert-True ($r.Erro -match 'falha real ao iniciar o processo') 'mensagem real precisa aparecer'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'sem processo nenhum, o estado volta direto pra Stopped'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── W: watchdog-sync-financeiro.ps1 (estático) ──────────────────────────
Teste 'W1. watchdog-sync-financeiro.ps1: o log de EstadoIncerto nunca usa "confirmacao registrada" (so os casos REALMENTE confirmados podem)' {
  $textoSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoWatchdog
  $m = [regex]::Match($textoSemComentarios, '(?s)if\s*\(\$decisaoInicio\.EstadoIncerto\)\s*\{.*?\n\s*\}')
  Assert-True $m.Success 'watchdog precisa ter um bloco especifico pra EstadoIncerto'
  Assert-True ($m.Value -notmatch 'confirmacao registrada') 'a mensagem do caso INCERTO nao pode dizer "confirmacao registrada"'
  Assert-True ($m.Value -match '(?i)NENHUM ack') 'precisa deixar explicito que nenhum ack foi gravado'
  Assert-True ($m.Value -match '(?i)NENHUM worker') 'precisa deixar explicito que nenhum worker foi iniciado'
}
Teste 'W2. watchdog-sync-financeiro.ps1: o catch externo desfaz qualquer handle ja criado antes de reiniciar o loop' {
  $textoSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoWatchdog
  # Ancora num texto UNICO que so aparece dentro do catch externo (nao
  # usa "} catch {" como marcador - esse padrao tambem aparece em varios
  # try/catch aninhados DENTRO do proprio catch externo, incluindo depois
  # do ponto que nos interessa, entao LastIndexOf pegaria o lugar errado).
  $posicaoCatchExterno = $textoSemComentarios.IndexOf('EXCECAO NAO TRATADA NO SUPERVISOR')
  Assert-True ($posicaoCatchExterno -ge 0) 'precisa haver um catch externo com esse log caracteristico'
  $trechoCatchExterno = $textoSemComentarios.Substring($posicaoCatchExterno)
  Assert-True ($trechoCatchExterno -match 'handleWorkerAtual') 'catch externo precisa checar a variavel de rastreio do handle atual'
  Assert-True ($trechoCatchExterno -match 'Invoke-SyncFinanceiroWatchdogDesfazerPartida') 'catch externo precisa desfazer a partida (matar/confirmar/drenar/liberar/gravar estado), nao so logar'
}
Teste 'W3. watchdog-sync-financeiro.ps1: lanca o worker com node.exe diretamente, nunca via cmd.exe' {
  $textoSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoWatchdog
  Assert-True ($textoSemComentarios -match "Start-SyncFinanceiroWorkerProcesso\s+-FileName\s+'node\.exe'") 'watchdog.ps1 precisa chamar Start-SyncFinanceiroWorkerProcesso com -FileName node.exe diretamente'
  Assert-True ($textoSemComentarios -notmatch "(?i)FileName\s*'?cmd\.exe") 'watchdog.ps1 nao pode mais lancar o worker via cmd.exe'
}
Teste 'W4. watchdog-sync-financeiro.ps1 nunca remove o sinalizador de parada em lugar nenhum' {
  $textoSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoWatchdog
  Assert-True ($textoSemComentarios -notmatch 'Remove-Item[^`n]*stop') 'watchdog nao pode remover o sinalizador de parada em nenhum ponto'
  Assert-True ($textoSemComentarios -notmatch 'Remove-SyncFinanceiroFlag') 'watchdog nao pode CHAMAR Remove-SyncFinanceiroFlag - so 3-LIGAR remove'
}
Teste 'W5. scripts\inicializar-protocolo-estado-worker.ps1 existe e exige -Confirmo explicito (estatico)' {
  $caminhoBootstrap = Join-Path $raizDoRepo 'scripts\inicializar-protocolo-estado-worker.ps1'
  Assert-True (Test-Path $caminhoBootstrap) 'o wrapper de bootstrap precisa existir'
  $texto = Get-Content -Raw $caminhoBootstrap
  Assert-True ($texto -match '\[switch\]\$Confirmo') 'precisa exigir a flag -Confirmo'
  Assert-True ($texto -match 'ConfirmeiQueNenhumWorkerAntigoEstaRodando') 'precisa repassar a confirmacao explicita pro modulo'
}

# ═══════════════════════════════════════════════════════════════════════
# ── P4: Start-SyncFinanceiroWorkerProcesso — testável isoladamente +
#      integração real com processo DESCARTÁVEL. NUNCA usa Get-Job (nem
#      bare nem filtrado) - só Get-EventSubscriber (tabela de assinaturas,
#      não o repositório global de jobs) e o resultado RICO devolvido por
#      Stop-SyncFinanceiroWorkerTracking. ────────────────────────────────
# ═══════════════════════════════════════════════════════════════════════

Teste 'P4a. Start-SyncFinanceiroWorkerProcesso/Stop-SyncFinanceiroWorkerTracking sao importaveis/chamaveis isoladamente (nao precisam do loop do watchdog) - exportados pelo modulo' {
  Assert-True ((Get-Command Start-SyncFinanceiroWorkerProcesso -ErrorAction SilentlyContinue) -ne $null) 'precisa estar exportado'
  Assert-True ((Get-Command Stop-SyncFinanceiroWorkerTracking -ErrorAction SilentlyContinue) -ne $null) 'idem pro cleanup'
}

Teste 'P4b. Integracao real (processo descartavel): handle real, stdout+stderr chegam ao log, append preserva conteudo, linhas finais nao se perdem, cleanup confirmado SEM enumerar jobs globais' {
  $raizTmp = Novo-RaizTemp
  $logPath = Join-Path $raizTmp 'worker-descartavel.log'
  Set-Content -Path $logPath -Value 'CONTEUDO-ANTERIOR-PRESERVADO' -Encoding utf8
  $handle = $null
  $jaLimpo = $false
  try {
    $codigo = @'
Write-Output "OUT-linha-1"
[Console]::Error.WriteLine("ERR-linha-1")
Start-Sleep -Milliseconds 250
Write-Output "OUT-linha-FINAL"
[Console]::Error.WriteLine("ERR-linha-FINAL")
'@
    $handle = Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos (New-ArgumentosPowerShellDescartavel -Codigo $codigo) -WorkingDirectory $raizTmp -LogPath $logPath

    Assert-True ($handle.Processo.Id -gt 0) 'PID precisa ser real'
    Assert-True ((Get-Process -Id $handle.Processo.Id -ErrorAction SilentlyContinue) -ne $null) 'o handle precisa corresponder a um processo REAL em execucao'
    Assert-True ((Get-EventSubscriber -SourceIdentifier $handle.AssinaturaSaida.Name -ErrorAction SilentlyContinue) -ne $null) 'assinatura de stdout precisa existir logo apos o start'
    Assert-True ((Get-EventSubscriber -SourceIdentifier $handle.AssinaturaErro.Name -ErrorAction SilentlyContinue) -ne $null) 'assinatura de stderr precisa existir logo apos o start'

    Assert-True (Wait-ProcessoSair -Processo $handle.Processo) 'processo descartavel precisa ter saido dentro do prazo do teste'
    Wait-SyncFinanceiroSaidaDrenada -Processo $handle.Processo
    $resultadoCleanup = Stop-SyncFinanceiroWorkerTracking -Handle $handle
    $jaLimpo = $true

    Assert-True $resultadoCleanup.AssinaturaSaidaRemovida 'remocao da assinatura de stdout precisa ter funcionado'
    Assert-True $resultadoCleanup.JobSaidaRemovido 'remocao do PSEventJob de stdout (via -Job, nunca -Name) precisa ter funcionado'
    Assert-True $resultadoCleanup.AssinaturaErroRemovida 'remocao da assinatura de stderr precisa ter funcionado'
    Assert-True $resultadoCleanup.JobErroRemovido 'remocao do PSEventJob de stderr (via -Job, nunca -Name) precisa ter funcionado'
    Assert-True $resultadoCleanup.WriterDescartado 'writer precisa ter sido descartado'
    Assert-True $resultadoCleanup.ProcessoDescartado 'Process precisa ter sido descartado'
    Assert-True ((Get-EventSubscriber -SourceIdentifier $handle.AssinaturaSaida.Name -ErrorAction SilentlyContinue) -eq $null) 'assinatura de stdout precisa ter sumido de verdade (verificacao independente do resultado)'
    Assert-True ((Get-EventSubscriber -SourceIdentifier $handle.AssinaturaErro.Name -ErrorAction SilentlyContinue) -eq $null) 'assinatura de stderr precisa ter sumido de verdade'

    $conteudo = Get-Content -Raw $logPath
    Assert-True ($conteudo -match 'CONTEUDO-ANTERIOR-PRESERVADO') 'append precisa preservar o conteudo que ja estava no arquivo'
    Assert-True ($conteudo -match 'OUT-linha-1') 'stdout precisa chegar ao log'
    Assert-True ($conteudo -match 'ERR-linha-1') 'stderr precisa chegar ao log'
    Assert-True ($conteudo -match 'OUT-linha-FINAL') 'ULTIMA linha de stdout nao pode se perder'
    Assert-True ($conteudo -match 'ERR-linha-FINAL') 'ULTIMA linha de stderr nao pode se perder'
  } finally {
    if (-not $jaLimpo) {
      if ($handle -and $handle.Processo) {
        try { if (-not $handle.Processo.HasExited) { Stop-Process -Id $handle.Processo.Id -Force -ErrorAction SilentlyContinue } } catch {}
      }
      if ($handle) { Stop-SyncFinanceiroWorkerTracking -Handle $handle | Out-Null }
    }
    Remove-Item -Recurse -Force $raizTmp -ErrorAction SilentlyContinue
  }
}

Teste 'P4c. Integracao real: encerramento via Stop-Process (nao saida natural) tambem drena a saida e confirma cleanup, sem enumerar jobs globais' {
  $raizTmp = Novo-RaizTemp
  $logPath = Join-Path $raizTmp 'worker-descartavel-kill.log'
  $handle = $null
  $jaLimpo = $false
  try {
    $codigo = @'
Write-Output "antes-de-dormir"
Start-Sleep -Seconds 30
Write-Output "NUNCA-deveria-aparecer"
'@
    $handle = Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos (New-ArgumentosPowerShellDescartavel -Codigo $codigo) -WorkingDirectory $raizTmp -LogPath $logPath

    Start-Sleep -Milliseconds 1000
    Stop-Process -Id $handle.Processo.Id -Force
    Assert-True (Wait-ProcessoSair -Processo $handle.Processo -TimeoutSegundos 10) 'precisa confirmar encerrado apos Stop-Process'

    Wait-SyncFinanceiroSaidaDrenada -Processo $handle.Processo
    $resultadoCleanup = Stop-SyncFinanceiroWorkerTracking -Handle $handle
    $jaLimpo = $true

    Assert-True $resultadoCleanup.AssinaturaSaidaRemovida 'kill tambem precisa deixar a assinatura de stdout removida'
    Assert-True $resultadoCleanup.JobSaidaRemovido 'kill tambem precisa deixar o PSEventJob de stdout removido'
    Assert-True $resultadoCleanup.AssinaturaErroRemovida 'kill tambem precisa deixar a assinatura de stderr removida'
    Assert-True $resultadoCleanup.JobErroRemovido 'kill tambem precisa deixar o PSEventJob de stderr removido'
    Assert-True ((Get-EventSubscriber -SourceIdentifier $handle.AssinaturaSaida.Name -ErrorAction SilentlyContinue) -eq $null) 'verificacao independente: assinatura de stdout sumiu'

    $conteudo = Get-Content -Raw $logPath -ErrorAction SilentlyContinue
    Assert-True ($conteudo -match 'antes-de-dormir') 'a saida ja emitida antes do kill precisa ter chegado ao log'
    Assert-True ($conteudo -notmatch 'NUNCA-deveria-aparecer') 'a linha depois do Sleep de 30s nao pode aparecer'
  } finally {
    if (-not $jaLimpo) {
      if ($handle -and $handle.Processo) {
        try { if (-not $handle.Processo.HasExited) { Stop-Process -Id $handle.Processo.Id -Force -ErrorAction SilentlyContinue } } catch {}
      }
      if ($handle) { Stop-SyncFinanceiroWorkerTracking -Handle $handle | Out-Null }
    }
    Remove-Item -Recurse -Force $raizTmp -ErrorAction SilentlyContinue
  }
}

Teste 'P4d. Integracao real: StreamWriter e Process sao descartados mesmo quando a PARTIDA falha (FileName inexistente)' {
  $raizTmp = Novo-RaizTemp
  $logPath = Join-Path $raizTmp 'worker-falha-partida.log'
  $capturouExcecao = $false
  try {
    # -Argumentos precisa de valor nao-vazio so pra passar do parameter
    # binding (Mandatory + string) - o que este teste forca e a falha REAL
    # em Process.Start() por causa do -FileName inexistente.
    Start-SyncFinanceiroWorkerProcesso -FileName 'executavel-que-definitivamente-nao-existe-12345.exe' -Argumentos '-NoOp' -WorkingDirectory $raizTmp -LogPath $logPath | Out-Null
  } catch {
    $capturouExcecao = $true
  }
  Assert-True $capturouExcecao 'FileName inexistente precisa lancar excecao real'
  Assert-True (Test-Path $logPath) 'o arquivo de log precisa ter sido criado antes da falha (StreamWriter abre primeiro)'
  Set-Content -Path $logPath -Value 'pos-falha-ok' -Encoding utf8 -ErrorAction Stop
  Assert-True ((Get-Content -Raw $logPath) -match 'pos-falha-ok') 'precisa conseguir escrever livremente depois - prova que o StreamWriter foi Dispose() mesmo na falha'
  Remove-Item -Recurse -Force $raizTmp -ErrorAction SilentlyContinue
}

Teste 'P4e. Integracao real: repetir varias partidas/paradas em sequencia nao acumula assinaturas de evento (verificado via Get-EventSubscriber, nunca o repositorio global de jobs)' {
  $raizTmp = Novo-RaizTemp
  try {
    1..3 | ForEach-Object {
      $logPath = Join-Path $raizTmp "worker-repeticao-$_.log"
      $codigo = "Write-Output 'ciclo-$_'"
      $handle = Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos (New-ArgumentosPowerShellDescartavel -Codigo $codigo) -WorkingDirectory $raizTmp -LogPath $logPath
      Wait-ProcessoSair -Processo $handle.Processo | Out-Null
      Wait-SyncFinanceiroSaidaDrenada -Processo $handle.Processo
      $resultadoCleanup = Stop-SyncFinanceiroWorkerTracking -Handle $handle
      Assert-True $resultadoCleanup.AssinaturaSaidaRemovida "ciclo $_ : assinatura de stdout precisa ter sido removida"
      Assert-True $resultadoCleanup.JobSaidaRemovido "ciclo $_ : PSEventJob de stdout precisa ter sido removido"
      Assert-True $resultadoCleanup.AssinaturaErroRemovida "ciclo $_ : assinatura de stderr precisa ter sido removida"
      Assert-True $resultadoCleanup.JobErroRemovido "ciclo $_ : PSEventJob de stderr precisa ter sido removido"
      Assert-True ((Get-EventSubscriber -SourceIdentifier $handle.AssinaturaSaida.Name -ErrorAction SilentlyContinue) -eq $null) "ciclo $_ : nenhuma assinatura de stdout pode sobrar"
      Assert-True ((Get-EventSubscriber -SourceIdentifier $handle.AssinaturaErro.Name -ErrorAction SilentlyContinue) -eq $null) "ciclo $_ : nenhuma assinatura de stderr pode sobrar"
    }
  } finally {
    Remove-Item -Recurse -Force $raizTmp -ErrorAction SilentlyContinue
  }
}

Teste 'P4f. Start-SyncFinanceiroWorkerProcesso: as DUAS assinaturas de evento vivem dentro do MESMO try que faz .Start() (estatico - garante que uma falha na 2a libera a 1a e o writer)' {
  $bloco = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Start-SyncFinanceiroWorkerProcesso'
  $posicaoTry = $bloco.IndexOf('try {')
  $posicaoAssinaturaSaida = $bloco.IndexOf('Register-ObjectEvent')
  # Ancora num texto UNICO do catch REAL (que libera as assinaturas) - "}
  # catch {" sozinho tambem casa com o catch aninhado, inofensivo, dentro
  # do PROPRIO scriptblock -Action (?$acaoSaida?), que aparece ANTES e
  # confundiria a posicao.
  $posicaoCatch = $bloco.IndexOf('if ($assinaturaErro) {')
  Assert-True ($posicaoTry -ge 0 -and $posicaoAssinaturaSaida -ge 0 -and $posicaoCatch -ge 0) 'precisa ter os 3 elementos'
  Assert-True ($posicaoTry -lt $posicaoAssinaturaSaida) 'as assinaturas precisam estar DENTRO do try (depois do try comecar)'
  Assert-True ($posicaoAssinaturaSaida -lt $posicaoCatch) 'as assinaturas precisam estar ANTES do catch real (dentro do bloco protegido)'
  $blocoCatch = $bloco.Substring($posicaoCatch)
  Assert-True ($blocoCatch -match 'assinaturaSaida') 'o catch precisa liberar a assinatura de stdout'
  Assert-True ($blocoCatch -match 'assinaturaErro') 'o catch precisa liberar a assinatura de stderr'
  Assert-True ($blocoCatch -match 'writer') 'o catch precisa liberar o writer'
  Assert-True ($blocoCatch -match '\$proc\.Dispose') 'o catch precisa liberar o Process'
}

# ═══════════════════════════════════════════════════════════════════════
# ── REVISAO 5 (6ª rodada) — exclusão mútua real, ACK como último commit,
#    ciclo de vida do Process, ProtocolVersion, PSEventJob sem -Name ─────
# ═══════════════════════════════════════════════════════════════════════

# ── V: validação de ProtocolVersion ─────────────────────────────────────
Teste 'V1. Get-SyncFinanceiroEstadoWorkerAtual: ProtocolVersion AUSENTE vira Unknown e bloqueia start' {
  $raiz = Novo-RaizTemp
  try {
    $objeto = [pscustomobject]@{ Estado = 'Stopped'; GeracaoId = 'g1'; Pid = $null; StartTimeUtc = $null; AtualizadoEm = (Get-Date).ToString('o') }
    ($objeto | ConvertTo-Json -Depth 5) | Set-Content -Path (Get-SyncFinanceiroEstadoPath -Raiz $raiz) -Encoding utf8
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Unknown' $e.Estado 'ProtocolVersion ausente precisa virar Unknown'
    Assert-True ($e.MotivoIncerto -match '(?i)ProtocolVersion') 'motivo precisa mencionar ProtocolVersion'
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'ProtocolVersion ausente nunca autoriza start'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'V2. Get-SyncFinanceiroEstadoWorkerAtual: ProtocolVersion=0 vira Unknown e bloqueia start' {
  $raiz = Novo-RaizTemp
  try {
    $objeto = [pscustomobject]@{ ProtocolVersion = 0; Estado = 'Stopped'; GeracaoId = 'g1'; Pid = $null; StartTimeUtc = $null; AtualizadoEm = (Get-Date).ToString('o') }
    ($objeto | ConvertTo-Json -Depth 5) | Set-Content -Path (Get-SyncFinanceiroEstadoPath -Raiz $raiz) -Encoding utf8
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Unknown' $e.Estado 'ProtocolVersion=0 precisa virar Unknown'
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'ProtocolVersion=0 nunca autoriza start'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'V3. Get-SyncFinanceiroEstadoWorkerAtual: ProtocolVersion FUTURA (2) vira Unknown e bloqueia start - este codigo so sabe interpretar a versao 1' {
  $raiz = Novo-RaizTemp
  try {
    $objeto = [pscustomobject]@{ ProtocolVersion = 2; Estado = 'Stopped'; GeracaoId = 'g1'; Pid = $null; StartTimeUtc = $null; AtualizadoEm = (Get-Date).ToString('o') }
    ($objeto | ConvertTo-Json -Depth 5) | Set-Content -Path (Get-SyncFinanceiroEstadoPath -Raiz $raiz) -Encoding utf8
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Unknown' $e.Estado 'ProtocolVersion futura precisa virar Unknown'
    Assert-True ($e.MotivoIncerto -match '(?i)ProtocolVersion') 'motivo precisa mencionar ProtocolVersion'
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'ProtocolVersion futura nunca autoriza start'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── L: exclusão mútua REAL cross-process ────────────────────────────────
Teste 'L1. Concorrencia REAL entre dois processos PowerShell descartaveis disputando o mesmo diretorio: EXATAMENTE uma geracao reivindica Starting (lock cross-process com FileShare.None)' {
  $raiz = Novo-RaizInicializada
  $scriptRacer = Join-Path $raiz 'racer.ps1'
  Set-Content -Path $scriptRacer -Encoding utf8 -Value @'
param([string]$ModulePath, [string]$Raiz, [string]$OutPath, [string]$Barreira)
Import-Module $ModulePath -Force
$geracaoId = [guid]::NewGuid().ToString()
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path $Barreira) -and $sw.Elapsed.TotalSeconds -lt 10) { Start-Sleep -Milliseconds 5 }
$resultado = $null
$erro = $null
try { $resultado = Invoke-SyncFinanceiroWatchdogInicio -Raiz $Raiz -GeracaoId $geracaoId -TimeoutLockSegundos 20 } catch { $erro = $_.Exception.Message }
[pscustomobject]@{ GeracaoId = $geracaoId; Reivindicado = [bool]$resultado.Reivindicado; DeveIniciarWorker = [bool]$resultado.DeveIniciarWorker; Erro = $erro } |
  ConvertTo-Json | Set-Content -Path $OutPath -Encoding utf8
'@
  $out1 = Join-Path $raiz 'racer1.json'
  $out2 = Join-Path $raiz 'racer2.json'
  $barreira = Join-Path $raiz 'barreira.go'
  $p1 = $null; $p2 = $null
  try {
    $p1 = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $scriptRacer, $caminhoModulo, $raiz, $out1, $barreira) -PassThru -WindowStyle Hidden -ErrorAction Stop
    $p2 = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $scriptRacer, $caminhoModulo, $raiz, $out2, $barreira) -PassThru -WindowStyle Hidden -ErrorAction Stop
    Start-Sleep -Milliseconds 300
    New-Item -ItemType File -Path $barreira -Force | Out-Null

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ((-not $p1.HasExited -or -not $p2.HasExited) -and $sw.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 100 }
    Assert-True $p1.HasExited 'processo 1 precisa ter terminado dentro do prazo'
    Assert-True $p2.HasExited 'processo 2 precisa ter terminado dentro do prazo'

    $r1 = Get-Content -Raw $out1 | ConvertFrom-Json
    $r2 = Get-Content -Raw $out2 | ConvertFrom-Json
    Assert-True ($null -eq $r1.Erro) "processo 1 nao pode ter lancado excecao inesperada: $($r1.Erro)"
    Assert-True ($null -eq $r2.Erro) "processo 2 nao pode ter lancado excecao inesperada: $($r2.Erro)"

    # @(...) precisa envolver o PIPELINE inteiro (nao so a entrada) - senao,
    # quando exatamente 1 item bate no filtro (o caminho feliz esperado!),
    # o PowerShell desembrulha o resultado de volta pra um objeto escalar
    # (sem propriedade .Count) em vez de manter um array de 1 elemento -
    # achado real desta rodada, pego pelo proprio teste falhando no
    # cenario correto.
    $reivindicaram = @(@($r1, $r2) | Where-Object { $_.Reivindicado })
    Assert-Equal 1 $reivindicaram.Count 'EXATAMENTE uma das duas geracoes concorrentes pode ter reivindicado Starting - exclusao mutua real entre PROCESSOS, nao so dentro do mesmo processo PowerShell'

    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Starting' $e.Estado 'o estado final precisa refletir a reivindicacao vencedora'
    Assert-Equal $reivindicaram[0].GeracaoId $e.GeracaoId 'o GeracaoId no disco precisa ser exatamente o da geracao vencedora'
  } finally {
    foreach ($p in @($p1, $p2)) { if ($p -and -not $p.HasExited) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} } }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}
Teste 'L2. Invoke-SyncFinanceiroComLockEstado libera o handle mesmo quando o corpo lanca (finally sempre roda) - proxima aquisicao nao fica bloqueada' {
  $raiz = Novo-RaizTemp
  try {
    $lancou = $false
    try {
      Invoke-SyncFinanceiroComLockEstado -Raiz $raiz -TimeoutSegundos 5 -Corpo { throw 'falha deliberada dentro do corpo' }
    } catch { $lancou = $true }
    Assert-True $lancou 'a excecao do corpo precisa propagar'
    # Hashtable mutavel capturada por closure - NUNCA atribuicao direta a
    # uma variavel local dentro do scriptblock (achado ja conhecido desta
    # suite: `& $Corpo` roda o scriptblock com leitura por closure, mas
    # ESCRITA sem $script:/hashtable cria uma variavel NOVA no escopo de
    # execucao do `&`, sem conectar de volta com a variavel local do Teste).
    $estado = @{ segundaAquisicaoFuncionou = $false }
    Invoke-SyncFinanceiroComLockEstado -Raiz $raiz -TimeoutSegundos 5 -Corpo { $estado.segundaAquisicaoFuncionou = $true }
    Assert-True $estado.segundaAquisicaoFuncionou 'uma segunda aquisicao do lock precisa funcionar - o handle da primeira NUNCA pode ficar preso apos uma excecao'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'L3. Set-SyncFinanceiroEstadoWorker/Initialize-SyncFinanceiroEstadoWorker/Invoke-SyncFinanceiroWatchdogInicio sao protegidos pelo lock (estrutural - releitura+decisao+escrita sob a MESMA secao critica)' {
  $textoModuloSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoModulo
  foreach ($nomeFuncao in @('Set-SyncFinanceiroEstadoWorker', 'Initialize-SyncFinanceiroEstadoWorker', 'Invoke-SyncFinanceiroWatchdogInicio')) {
    $bloco = Get-BlocoDeFuncao -Texto $textoModuloSemComentarios -NomeFuncao $nomeFuncao
    Assert-True ($bloco -match 'Invoke-SyncFinanceiroComLockEstado') "$nomeFuncao precisa rodar sob Invoke-SyncFinanceiroComLockEstado"
  }
}
Teste 'B1. Set-SyncFinanceiroEstadoWorkerBruto (bypass generico de ownership) foi ELIMINADO do modulo - nem existe como funcao, nem esta exportado' {
  Assert-True ((Get-Command Set-SyncFinanceiroEstadoWorkerBruto -ErrorAction SilentlyContinue) -eq $null) 'a funcao nao pode mais existir como comando disponivel (nem interno nem exportado)'
  $modulo = Get-Module sync-financeiro-control
  Assert-True ($null -eq $modulo -or -not $modulo.ExportedFunctions.ContainsKey('Set-SyncFinanceiroEstadoWorkerBruto')) 'nao pode aparecer na lista de funcoes exportadas do modulo'
  Assert-True ($textoModulo -notmatch 'function\s+Set-SyncFinanceiroEstadoWorkerBruto') 'o texto do modulo nao pode mais DEFINIR essa funcao (mencao em comentario historico e permitida)'
}

# ── IL: lock de INSTÂNCIA do supervisor (Fase 2E, 7ª rodada) ────────────
Teste 'IL1. Invoke-SyncFinanceiroAdquirirLockInstancia: segunda tentativa NO MESMO processo falha enquanto a primeira nao for liberada; funciona de novo apos liberar' {
  $raiz = Novo-RaizTemp
  $r1 = $null
  try {
    $r1 = Invoke-SyncFinanceiroAdquirirLockInstancia -Raiz $raiz
    Assert-True $r1.Adquirido 'primeira aquisicao precisa funcionar'
    $r2 = Invoke-SyncFinanceiroAdquirirLockInstancia -Raiz $raiz
    Assert-True (-not $r2.Adquirido) 'segunda aquisicao PRECISA falhar enquanto a primeira mantiver o lock'
    Assert-True ($null -ne $r2.Erro) 'precisa reportar um erro real'
    Close-SyncFinanceiroLockInstancia -Resultado $r1
    $r1 = $null
    $r3 = Invoke-SyncFinanceiroAdquirirLockInstancia -Raiz $raiz
    Assert-True $r3.Adquirido 'apos liberar a primeira, uma nova aquisicao precisa funcionar'
    Close-SyncFinanceiroLockInstancia -Resultado $r3
  } finally {
    if ($r1) { Close-SyncFinanceiroLockInstancia -Resultado $r1 }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}
Teste 'IL2. Lock de instancia e um arquivo FIXO SEPARADO do lock de transicao da maquina de estados (nunca o mesmo caminho)' {
  $raiz = Novo-RaizTemp
  Assert-True ((Get-SyncFinanceiroLockInstanciaPath -Raiz $raiz) -ne (Get-SyncFinanceiroLockPath -Raiz $raiz)) 'os dois locks precisam usar arquivos diferentes - instancia e transicao sao secoes criticas INDEPENDENTES'
}
Teste 'IL3. watchdog-sync-financeiro.ps1: adquire o lock de instancia LOGO NO INICIO (antes de qualquer chamada de reconciliacao/decisao) e sai imediatamente se falhar' {
  $textoSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoWatchdog
  $posAdquirir = $textoSemComentarios.IndexOf('Invoke-SyncFinanceiroAdquirirLockInstancia')
  $posPrimeiraDecisao = $textoSemComentarios.IndexOf('Invoke-SyncFinanceiroWatchdogInicioComRetentativas')
  Assert-True ($posAdquirir -ge 0) 'watchdog precisa chamar Invoke-SyncFinanceiroAdquirirLockInstancia'
  Assert-True ($posPrimeiraDecisao -ge 0) 'watchdog precisa chamar a decisao de inicio em algum ponto'
  Assert-True ($posAdquirir -lt $posPrimeiraDecisao) 'o lock de instancia precisa ser adquirido ANTES de qualquer chamada de reconciliacao/decisao'
  $trechoAteDecisao = $textoSemComentarios.Substring($posAdquirir, $posPrimeiraDecisao - $posAdquirir)
  Assert-True ($trechoAteDecisao -match '(?s)if\s*\(-not\s*\$resultadoLockInstancia\.Adquirido\)\s*\{[^}]*exit 0') 'se a aquisicao falhar, o script precisa sair (exit 0) ANTES de chegar em qualquer decisao/reconciliacao'
}
Teste 'IL4. Lock de instancia REAL entre dois processos: a primeira instancia chega a Running e mantem o lock aberto; a segunda (iniciada depois) sai IMEDIATAMENTE sem reconciliar, matar ou iniciar worker nenhum' {
  $raiz = Novo-RaizInicializada
  $racer1 = Join-Path $raiz 'racer-instancia1.ps1'
  $racer2 = Join-Path $raiz 'racer-instancia2.ps1'
  Set-Content -Path $racer1 -Encoding utf8 -Value @'
param([string]$ModulePath, [string]$Raiz, [string]$LogPath, [string]$ReadyPath, [string]$StopPath, [string]$ResultPath)
Import-Module $ModulePath -Force
$lockInstancia = Invoke-SyncFinanceiroAdquirirLockInstancia -Raiz $Raiz
if (-not $lockInstancia.Adquirido) {
  [pscustomobject]@{ Etapa = 'lock-instancia'; Sucesso = $false; Erro = $lockInstancia.Erro } | ConvertTo-Json | Set-Content -Path $ResultPath -Encoding utf8
  exit 1
}
$geracaoId = [guid]::NewGuid().ToString()
$decisao = Invoke-SyncFinanceiroWatchdogInicio -Raiz $Raiz -GeracaoId $geracaoId
if (-not $decisao.DeveIniciarWorker) {
  [pscustomobject]@{ Etapa = 'reivindicar'; Sucesso = $false; Erro = $decisao.MotivoBloqueio } | ConvertTo-Json | Set-Content -Path $ResultPath -Encoding utf8
  exit 1
}
$codigo = 'Start-Sleep -Seconds 30'
$argumentos = "-NoProfile -NonInteractive -EncodedCommand $([Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($codigo)))"
$handle = Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos $argumentos -WorkingDirectory $Raiz -LogPath $LogPath
$proc = $handle.Processo
$startTimeUtc = $proc.StartTime.ToUniversalTime()
$rRunning = Set-SyncFinanceiroEstadoWorker -Raiz $Raiz -Estado 'Running' -GeracaoId $geracaoId -WorkerPid $proc.Id -StartTimeUtc $startTimeUtc
[pscustomobject]@{ Etapa = 'running'; Sucesso = $rRunning.Sucesso; ChildPid = $proc.Id; GeracaoId = $geracaoId } | ConvertTo-Json | Set-Content -Path $ReadyPath -Encoding utf8

$sw = [System.Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path $StopPath) -and $sw.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 100 }

try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch {}
try { Stop-SyncFinanceiroWorkerTracking -Handle $handle | Out-Null } catch {}
[pscustomobject]@{ Etapa = 'finalizado'; Sucesso = $true } | ConvertTo-Json | Set-Content -Path $ResultPath -Encoding utf8
# o lock de instancia NUNCA e fechado explicitamente aqui - o SO libera
# sozinho quando este processo terminar, exatamente como no supervisor real.
'@
  Set-Content -Path $racer2 -Encoding utf8 -Value @'
param([string]$ModulePath, [string]$Raiz, [string]$ReadyPath, [string]$ResultPath)
Import-Module $ModulePath -Force
$sw = [System.Diagnostics.Stopwatch]::StartNew()
while (-not (Test-Path $ReadyPath) -and $sw.Elapsed.TotalSeconds -lt 20) { Start-Sleep -Milliseconds 50 }
$lockInstancia = Invoke-SyncFinanceiroAdquirirLockInstancia -Raiz $Raiz
[pscustomobject]@{ Adquirido = [bool]$lockInstancia.Adquirido; Erro = $lockInstancia.Erro } | ConvertTo-Json | Set-Content -Path $ResultPath -Encoding utf8
if ($lockInstancia.Adquirido) { try { $lockInstancia.Stream.Dispose() } catch {} }
'@
  $logPath1 = Join-Path $raiz 'worker-instancia1.log'
  $readyPath = Join-Path $raiz 'ready.json'
  $stopPath = Join-Path $raiz 'stop.go'
  $resultPath1 = Join-Path $raiz 'result1.json'
  $resultPath2 = Join-Path $raiz 'result2.json'
  $p1 = $null; $p2 = $null
  try {
    $p1 = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $racer1, $caminhoModulo, $raiz, $logPath1, $readyPath, $stopPath, $resultPath1) -PassThru -WindowStyle Hidden -ErrorAction Stop

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path $readyPath) -and $sw.Elapsed.TotalSeconds -lt 20) { Start-Sleep -Milliseconds 100 }
    Assert-True (Test-Path $readyPath) 'a primeira instancia precisa ter chegado a Running dentro do prazo'
    $ready = Get-Content -Raw $readyPath | ConvertFrom-Json
    Assert-True $ready.Sucesso 'a primeira instancia precisa ter persistido Running com sucesso'
    $childPid = $ready.ChildPid

    $p2 = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-File', $racer2, $caminhoModulo, $raiz, $readyPath, $resultPath2) -PassThru -WindowStyle Hidden -ErrorAction Stop
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $p2.HasExited -and $sw.Elapsed.TotalSeconds -lt 20) { Start-Sleep -Milliseconds 100 }
    Assert-True $p2.HasExited 'a segunda instancia precisa terminar rapido (nao pode ficar esperando)'

    $r2 = Get-Content -Raw $resultPath2 | ConvertFrom-Json
    Assert-True (-not $r2.Adquirido) 'a SEGUNDA instancia NUNCA pode adquirir o lock enquanto a primeira estiver viva'

    # A primeira instancia (e o worker dela) precisam continuar vivos -
    # a segunda nunca reconciliou, nunca matou, nunca iniciou nada.
    Assert-True (-not $p1.HasExited) 'a PRIMEIRA instancia precisa continuar viva - a segunda nao pode te-la afetado'
    Assert-True ((Get-Process -Id $childPid -ErrorAction SilentlyContinue) -ne $null) 'o processo do WORKER da primeira instancia precisa continuar vivo - a segunda nunca pode mata-lo ou substitui-lo'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Running' $e.Estado 'o estado precisa continuar Running - a segunda instancia nunca tocou a maquina de estados'
    Assert-Equal $ready.GeracaoId $e.GeracaoId 'o dono precisa continuar sendo a PRIMEIRA instancia'

    # Sinaliza a primeira pra encerrar de forma limpa e confirma que ela
    # (e so ela) conseguiu encerrar o proprio worker.
    New-Item -ItemType File -Path $stopPath -Force | Out-Null
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while (-not $p1.HasExited -and $sw.Elapsed.TotalSeconds -lt 20) { Start-Sleep -Milliseconds 100 }
    Assert-True $p1.HasExited 'a primeira instancia precisa terminar apos o sinal de parada'
    $r1 = Get-Content -Raw $resultPath1 | ConvertFrom-Json
    Assert-True $r1.Sucesso 'a primeira instancia precisa ter finalizado com sucesso'
  } finally {
    foreach ($p in @($p1, $p2)) { if ($p -and -not $p.HasExited) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} } }
    if ($childPid) { try { Get-Process -Id $childPid -ErrorAction Stop | Stop-Process -Force -ErrorAction SilentlyContinue } catch {} }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}

# ── D: desfazimento não confirmado preserva identidade e nunca sobrescreve
#      uma geração mais nova ────────────────────────────────────────────
Teste 'D1. Invoke-SyncFinanceiroWatchdogDesfazerPartida: morte NAO confirmada NUNCA descarta o handle - devolve vivo, grava Unknown com Pid/StartTimeUtc/GeracaoId, e bloqueia novo start' {
  $raiz = Novo-RaizInicializada
  try {
    $geracaoId = [guid]::NewGuid().ToString()
    $claim = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoId
    Assert-True $claim.DeveIniciarWorker 'precondicao: reivindicacao atomica precisa funcionar'
    $procFake = [pscustomobject]@{ Id = 9191; StartTime = (Get-Date) }
    $handleFake = [pscustomobject]@{ Processo = $procFake; Writer = $null; AssinaturaSaida = $null; AssinaturaErro = $null }
    $chamouLiberarTracking = @{ n = 0 }

    $resultado = Invoke-SyncFinanceiroWatchdogDesfazerPartida -Raiz $raiz -GeracaoId $geracaoId -Handle $handleFake `
      -PararProcesso { param($H) } -ConfirmarSaida { param($H) $false } -DrenarSaida { param($H) } `
      -LiberarTracking { param($H) $chamouLiberarTracking.n++ } `
      -TimeoutSegundos 2 -IntervaloSegundos 1 -Dormir $dormirInstantaneo

    Assert-True (-not $resultado.Confirmado) 'morte nao confirmada precisa refletir Confirmado=false'
    Assert-True ($null -ne $resultado.Handle) 'o HANDLE precisa voltar vivo - nunca descartado em silencio quando a morte nao foi confirmada'
    Assert-Equal $handleFake $resultado.Handle 'precisa ser o MESMO handle, nao um substituto'
    Assert-Equal 0 $chamouLiberarTracking.n 'LiberarTracking (Dispose) NUNCA pode ser chamado quando a morte nao foi confirmada'

    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Unknown' $e.Estado 'estado final precisa ser Unknown (nunca finge Stopped sobre uma incerteza)'
    Assert-Equal 9191 $e.Pid 'a identidade (Pid) precisa ser preservada no Unknown, pra uma futura reconciliacao'
    Assert-Equal $geracaoId $e.GeracaoId 'o GeracaoId precisa ser preservado'
    Assert-True ($null -ne $e.StartTimeUtc) 'o StartTimeUtc precisa ser preservado'

    # E o bloqueio real: uma geracao NOVA nao pode iniciar sobre este Unknown.
    $d2 = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d2.DeveIniciarWorker) 'Unknown com identidade preservada ainda bloqueia start de uma geracao nova'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'D2. Invoke-SyncFinanceiroWatchdogDesfazerPartida: geracao ANTIGA nao sobrescreve o estado de uma geracao NOVA que ja assumiu o controle (nem por erro, nem pelo proprio desfazimento) - reporta EstadoPersistido=false explicitamente' {
  $raiz = Novo-RaizInicializada
  try {
    $geracaoAntiga = [guid]::NewGuid().ToString()
    $claim = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId $geracaoAntiga
    Assert-True $claim.DeveIniciarWorker 'precondicao: a geracao antiga precisa ter reivindicado Starting primeiro'

    # Simula uma geracao NOVA legitima assumindo o controle nesse meio-tempo
    # (ex.: apos a antiga ter sido considerada perdida por outro mecanismo) -
    # escreve a fixture DIRETAMENTE no arquivo (fora do modulo), que e o
    # unico jeito de simular isso sem depender de outro processo real.
    $geracaoNova = [guid]::NewGuid().ToString()
    Set-SyncFinanceiroEstadoFixture -Raiz $raiz -Estado 'Running' -GeracaoId $geracaoNova -WorkerPid 12345 -StartTimeUtc (Get-Date) | Out-Null

    $procFake = [pscustomobject]@{ Id = 555; StartTime = (Get-Date) }
    $handleFake = [pscustomobject]@{ Processo = $procFake; Writer = $null; AssinaturaSaida = $null; AssinaturaErro = $null }
    $resultado = Invoke-SyncFinanceiroWatchdogDesfazerPartida -Raiz $raiz -GeracaoId $geracaoAntiga -Handle $handleFake `
      -PararProcesso { param($H) } -ConfirmarSaida { param($H) $true } -DrenarSaida { param($H) } -LiberarTracking { param($H) } `
      -TimeoutSegundos 2 -IntervaloSegundos 1 -Dormir $dormirInstantaneo

    Assert-True $resultado.Confirmado 'a morte do processo (fake) da geracao antiga foi confirmada normalmente'
    Assert-True (-not $resultado.EstadoPersistido) 'a ESCRITA precisa ter sido recusada - a geracao antiga nao e mais dona'
    Assert-True ($resultado.ErroPersistencia -match '(?i)outra geracao') 'o erro real precisa explicar o conflito de ownership'

    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal $geracaoNova $e.GeracaoId 'o estado no disco precisa continuar pertencendo a geracao NOVA, intocado'
    Assert-Equal 'Running' $e.Estado 'o Estado da geracao nova tambem precisa continuar intocado'
    Assert-Equal 12345 $e.Pid 'os dados da geracao nova precisam estar 100% intactos'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── AP: ACK como último registro de "commit" (Parar) ────────────────────
Teste 'AP1. Invoke-SyncFinanceiroWatchdogPararEConfirmar: se a gravacao de Stopped falhar (ownership recusado), o ACK Parado NUNCA e publicado - erro explicito, nenhum ack/heartbeat gravado' {
  $raiz = Novo-RaizInicializada
  try {
    $geracaoDona = (Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz).GeracaoId
    $geracaoErrada = [guid]::NewGuid().ToString()
    Assert-True ($geracaoErrada -ne $geracaoDona) 'precondicao do teste: precisa ser um GeracaoId genuinamente diferente do dono atual'

    $resultado = Invoke-SyncFinanceiroWatchdogPararEConfirmar -Raiz $raiz -GeracaoId $geracaoErrada -RequestId 'req-teste' -WorkerPid 321 `
      -PararProcesso { } -ProcessoSaiu { $true } -TimeoutSegundos 2 -IntervaloSegundos 1 -Dormir $dormirInstantaneo

    Assert-True $resultado.Confirmado 'a morte do processo (fake) foi confirmada'
    Assert-True (-not $resultado.EstadoPersistido) 'a persistencia de Stopped precisa ter falhado (ownership recusado)'
    Assert-True (-not $resultado.AckPublicado) 'ACK Parado NUNCA pode ser publicado quando Estado=Stopped nao foi persistido'
    Assert-True ($resultado.Erro -match '(?i)ACK Parado NAO publicado') 'o erro precisa deixar EXPLICITO que o ACK nao foi publicado'
    Assert-True ((Get-SyncFinanceiroAckAtual -Raiz $raiz) -eq $null) 'nenhum ack pode existir no disco'
    Assert-True ((Get-SyncFinanceiroHeartbeatAtual -Raiz $raiz) -eq $null) 'nenhum heartbeat pode existir no disco'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}
Teste 'AP2. Invoke-SyncFinanceiroWatchdogPararEConfirmar: caminho feliz - Stopped persistido ANTES do ACK, e o ACK/heartbeat sao o ULTIMO passo (ordem verificada por chamadas instrumentadas)' {
  $raiz = Novo-RaizInicializada
  try {
    $geracaoId = (Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz).GeracaoId
    $ordem = [System.Collections.Generic.List[string]]::new()
    # ProcessoSaiu e o ultimo ponto injetavel ANTES da persistencia real -
    # instrumentamos ele e conferimos, depois, que Stopped/ack realmente
    # ficaram gravados nessa ordem no disco.
    $resultado = Invoke-SyncFinanceiroWatchdogPararEConfirmar -Raiz $raiz -GeracaoId $geracaoId -RequestId 'req-ap2' -WorkerPid 654 `
      -PararProcesso { $ordem.Add('parar') } -ProcessoSaiu { $ordem.Add('saiu-confirmado'); $true } `
      -DrenarSaida { $ordem.Add('drenar') } -TimeoutSegundos 2 -IntervaloSegundos 1 -Dormir $dormirInstantaneo

    Assert-True $resultado.Confirmado 'precisa confirmar'
    Assert-True $resultado.EstadoPersistido 'Stopped precisa ter sido persistido'
    Assert-True $resultado.AckPublicado 'ACK precisa ter sido publicado'
    Assert-Equal 'parar,saiu-confirmado,drenar' ($ordem -join ',') 'ordem das etapas injetadas precisa ser parar->confirmar->drenar, ANTES de qualquer persistencia/ACK'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'estado final precisa ser Stopped'
    $ack = Get-SyncFinanceiroAckAtual -Raiz $raiz
    Assert-Equal 'Parado' $ack.Estado 'ack final precisa ser Parado'
    Assert-Equal 'req-ap2' $ack.RequestId 'RequestId do ack precisa ser exato'
  } finally { Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue }
}

# ── HB: falha INJETADA no heartbeat bloqueia o ACK nos 3 caminhos
#      (Fase 2E, 7ª rodada) ─────────────────────────────────────────────
# Trava o arquivo de heartbeat com FileShare.None ANTES de chamar a
# funcao - forca o Move-Item interno de Write-SyncFinanceiroHeartbeat a
# falhar de verdade (achado real, confirmado empiricamente nesta rodada),
# simulando exatamente "heartbeat falhou por I/O" sem precisar de nenhum
# hook injetavel especial.
Teste 'HB1. Confirm-SyncFinanceiroParadaAposSaidaNatural: falha INJETADA no heartbeat propaga, NENHUM ack e publicado' {
  $raiz = Novo-RaizTemp
  $streamTravando = $null
  try {
    New-SyncFinanceiroFlag -Raiz $raiz -RequestId 'req-hb1'
    $streamTravando = [System.IO.File]::Open((Get-SyncFinanceiroHeartbeatPath -Raiz $raiz), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    $lancou = $false
    try { Confirm-SyncFinanceiroParadaAposSaidaNatural -Raiz $raiz | Out-Null } catch { $lancou = $true }
    Assert-True $lancou 'a falha injetada no heartbeat precisa propagar (nao pode ser engolida em silencio)'
    Assert-True ((Get-SyncFinanceiroAckAtual -Raiz $raiz) -eq $null) 'NENHUM ack pode existir - o heartbeat (que vem ANTES) falhou'
  } finally {
    if ($streamTravando) { $streamTravando.Dispose() }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}
Teste 'HB2. Invoke-SyncFinanceiroWatchdogPararEConfirmar: falha INJETADA no heartbeat (Stopped ja persistido) propaga, NENHUM ack e publicado' {
  $raiz = Novo-RaizInicializada
  $streamTravando = $null
  try {
    $geracaoId = (Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz).GeracaoId
    $streamTravando = [System.IO.File]::Open((Get-SyncFinanceiroHeartbeatPath -Raiz $raiz), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    $lancou = $false
    try {
      Invoke-SyncFinanceiroWatchdogPararEConfirmar -Raiz $raiz -GeracaoId $geracaoId -RequestId 'req-hb2' -WorkerPid 999 `
        -PararProcesso { } -ProcessoSaiu { $true } -TimeoutSegundos 2 -IntervaloSegundos 1 -Dormir $dormirInstantaneo | Out-Null
    } catch { $lancou = $true }
    Assert-True $lancou 'a falha injetada no heartbeat precisa propagar'
    Assert-True ((Get-SyncFinanceiroAckAtual -Raiz $raiz) -eq $null) 'NENHUM ack pode existir - a falha aconteceu ANTES do ACK (heartbeat vem primeiro)'
    $e = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $raiz
    Assert-Equal 'Stopped' $e.Estado 'Estado=Stopped precisa ter sido persistido normalmente - a falha foi so no heartbeat, que vem DEPOIS da persistencia'
  } finally {
    if ($streamTravando) { $streamTravando.Dispose() }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}
Teste 'HB3. Invoke-SyncFinanceiroWatchdogInicio (caminho com sinalizador): falha INJETADA no heartbeat - EstadoIncerto=true com o erro real, NENHUM ack e publicado' {
  $raiz = Novo-RaizInicializada
  $streamTravando = $null
  try {
    New-SyncFinanceiroFlag -Raiz $raiz -RequestId 'req-hb3'
    $streamTravando = [System.IO.File]::Open((Get-SyncFinanceiroHeartbeatPath -Raiz $raiz), [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
    $d = Invoke-SyncFinanceiroWatchdogInicio -Raiz $raiz -GeracaoId ([guid]::NewGuid().ToString())
    Assert-True (-not $d.DeveIniciarWorker) 'nunca pode autorizar start quando a confirmacao de "Parado" nao pode ser publicada'
    Assert-True $d.EstadoIncerto 'precisa reportar EstadoIncerto quando o heartbeat falha dentro da secao critica'
    Assert-True ((Get-SyncFinanceiroAckAtual -Raiz $raiz) -eq $null) 'NENHUM ack pode existir - o heartbeat (que vem ANTES) falhou'
  } finally {
    if ($streamTravando) { $streamTravando.Dispose() }
    Remove-Item -Recurse -Force $raiz -ErrorAction SilentlyContinue
  }
}

# ── AL: ACK como último registro de "commit" (Ligar) ─────────────────────
Teste 'AL1. Invoke-SyncFinanceiroWatchdogConfirmarInicio: heartbeat e gravado ANTES do ACK Rodando (estatico - ACK e sempre o ULTIMO passo, nada de "commit" roda depois dele)' {
  $bloco = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Invoke-SyncFinanceiroWatchdogConfirmarInicio'
  $posHeartbeat = $bloco.IndexOf('Write-SyncFinanceiroHeartbeat')
  $posAck = $bloco.LastIndexOf('Write-SyncFinanceiroAck')
  Assert-True ($posHeartbeat -ge 0 -and $posAck -ge 0) 'precisa ter as duas chamadas'
  Assert-True ($posHeartbeat -lt $posAck) 'o heartbeat (artefato falivel) precisa vir ANTES do ACK Rodando (o "commit" final)'
}
Teste 'AL2. Confirm-SyncFinanceiroParadaAposSaidaNatural / Invoke-SyncFinanceiroWatchdogPararEConfirmar / caminho-com-sinalizador de Invoke-SyncFinanceiroWatchdogInicio: heartbeat SEMPRE antes do ACK (estatico, nos 3 caminhos pedidos pela revisao)' {
  $blocoConfirmNatural = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Confirm-SyncFinanceiroParadaAposSaidaNatural'
  $posHb1 = $blocoConfirmNatural.IndexOf('Write-SyncFinanceiroHeartbeat')
  $posAck1 = $blocoConfirmNatural.IndexOf('Write-SyncFinanceiroAck')
  Assert-True ($posHb1 -ge 0 -and $posAck1 -ge 0) 'Confirm-SyncFinanceiroParadaAposSaidaNatural precisa ter as duas chamadas'
  Assert-True ($posHb1 -lt $posAck1) 'Confirm-SyncFinanceiroParadaAposSaidaNatural: heartbeat precisa vir ANTES do ACK'

  $blocoPararEConfirmar = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Invoke-SyncFinanceiroWatchdogPararEConfirmar'
  $posHb2 = $blocoPararEConfirmar.IndexOf('Write-SyncFinanceiroHeartbeat')
  $posAck2 = $blocoPararEConfirmar.IndexOf('Write-SyncFinanceiroAck')
  Assert-True ($posHb2 -ge 0 -and $posAck2 -ge 0) 'Invoke-SyncFinanceiroWatchdogPararEConfirmar precisa ter as duas chamadas (caminho feliz)'
  Assert-True ($posHb2 -lt $posAck2) 'Invoke-SyncFinanceiroWatchdogPararEConfirmar: heartbeat precisa vir ANTES do ACK'

  $blocoInicio = Get-BlocoDeFuncao -Texto $textoModulo -NomeFuncao 'Invoke-SyncFinanceiroWatchdogInicio'
  $posSinalizador = $blocoInicio.IndexOf('SINALIZADOR PRESENTE')
  Assert-True ($posSinalizador -ge 0) 'precisa existir o bloco do caminho com sinalizador presente'
  $trechoSinalizador = $blocoInicio.Substring($posSinalizador)
  $posHb3 = $trechoSinalizador.IndexOf('Write-SyncFinanceiroHeartbeat')
  $posAck3 = $trechoSinalizador.IndexOf('Write-SyncFinanceiroAck')
  Assert-True ($posHb3 -ge 0 -and $posAck3 -ge 0) 'Invoke-SyncFinanceiroWatchdogInicio (caminho com sinalizador) precisa ter as duas chamadas'
  Assert-True ($posHb3 -lt $posAck3) 'Invoke-SyncFinanceiroWatchdogInicio (caminho com sinalizador): heartbeat precisa vir ANTES do ACK'
}

# ── ND: ciclo de vida do Process - nunca acessar apos Dispose ───────────
Teste 'ND1. Padrao de morte natural: capturar Id/ExitCode ANTES de Stop-SyncFinanceiroWorkerTracking funciona; acessar DEPOIS lanca (prova por que a ordem importa)' {
  $raizTmp = Novo-RaizTemp
  $logPath = Join-Path $raizTmp 'worker-nd1.log'
  try {
    $handle = Start-SyncFinanceiroWorkerProcesso -FileName 'powershell.exe' -Argumentos (New-ArgumentosPowerShellDescartavel -Codigo "Write-Output 'ok'") -WorkingDirectory $raizTmp -LogPath $logPath
    Assert-True (Wait-ProcessoSair -Processo $handle.Processo) 'processo descartavel precisa sair sozinho dentro do prazo'
    Wait-SyncFinanceiroSaidaDrenada -Processo $handle.Processo

    # PADRAO CORRETO (o mesmo que watchdog-sync-financeiro.ps1 usa desde a
    # 6a rodada): captura ANTES de descartar.
    $pidCapturado = $handle.Processo.Id
    $exitCodeCapturado = $handle.Processo.ExitCode
    Assert-True ($pidCapturado -gt 0) 'PID capturado antes do Dispose precisa ser real'
    Assert-Equal 0 $exitCodeCapturado 'exit code capturado antes do Dispose precisa refletir a saida normal'

    Stop-SyncFinanceiroWorkerTracking -Handle $handle | Out-Null

    # A PARTIR DAQUI o Process foi descartado. Confirmado empiricamente
    # nesta rodada: o comportamento pos-Dispose NAO e um contrato
    # confiavel de "sempre lanca excecao" (varia por propriedade/runtime -
    # as vezes lanca, as vezes devolve silenciosamente vazio/nulo). Por
    # isso o modulo/watchdog NUNCA dependem de pegar uma excecao pra saber
    # que e tarde demais - a regra e simplesmente NUNCA acessar essas
    # propriedades depois de Stop-SyncFinanceiroWorkerTracking. Este teste
    # verifica isso empiricamente: o valor lido DEPOIS nunca pode ser
    # confiavelmente igual ao valor real capturado ANTES.
    $valorAposDispose = $null
    $naoConfiavel = $false
    try { $valorAposDispose = $handle.Processo.Id } catch { $naoConfiavel = $true }
    if (-not $naoConfiavel) {
      $naoConfiavel = [string]::IsNullOrEmpty("$valorAposDispose") -or ($valorAposDispose -ne $pidCapturado)
    }
    Assert-True $naoConfiavel 'acessar .Id APOS Stop-SyncFinanceiroWorkerTracking precisa lancar OU deixar de devolver o PID real (Process ja descartado) - por isso a ordem (capturar/persistir ANTES de descartar) e obrigatoria, nunca opcional'
  } finally { Remove-Item -Recurse -Force $raizTmp -ErrorAction SilentlyContinue }
}
Teste 'ND2. watchdog-sync-financeiro.ps1: no caminho de morte NATURAL, Estado=Stopped e persistido ANTES de Stop-SyncFinanceiroWorkerTracking (que descarta o Process), nunca depois' {
  $textoSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoWatchdog
  $ancora = 'worker (node.exe) encerrou (exit code'
  $posicaoAncora = $textoSemComentarios.IndexOf($ancora)
  Assert-True ($posicaoAncora -ge 0) 'precisa existir o log de morte natural'
  $trecho = $textoSemComentarios.Substring($posicaoAncora, [Math]::Min(500, $textoSemComentarios.Length - $posicaoAncora))
  $posSet = $trecho.IndexOf("Set-SyncFinanceiroEstadoWorker -Raiz `$raiz -Estado 'Stopped'")
  $posStop = $trecho.IndexOf('Stop-SyncFinanceiroWorkerTracking')
  Assert-True ($posSet -ge 0 -and $posStop -ge 0) 'precisa ter as duas chamadas logo apos o log de morte natural'
  Assert-True ($posSet -lt $posStop) 'Estado=Stopped precisa ser persistido ANTES de Stop-SyncFinanceiroWorkerTracking - nunca depois'
}

# ── J: cleanup por objeto PSEventJob, nunca -Name (evita busca no
#      repositório global de jobs / avisos de PSScheduledJob) ───────────
Teste 'J1. sync-financeiro-control.psm1: Remove-Job sempre usa -Job (referencia direta do PSEventJob), nunca -Name' {
  $textoModuloSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoModulo
  $chamadasRemoveJob = [regex]::Matches($textoModuloSemComentarios, 'Remove-Job\s+[^\r\n]*')
  Assert-True ($chamadasRemoveJob.Count -ge 4) 'esperava varias chamadas reais a Remove-Job no modulo (Start-SyncFinanceiroWorkerProcesso + Stop-SyncFinanceiroWorkerTracking)'
  foreach ($m in $chamadasRemoveJob) {
    Assert-True ($m.Value -match '-Job\s') "toda chamada a Remove-Job precisa usar -Job (objeto direto): '$($m.Value)'"
    Assert-True ($m.Value -notmatch '-Name\s') "nenhuma chamada a Remove-Job pode usar -Name (forca busca no repositorio GLOBAL de jobs, inclusive PSScheduledJob): '$($m.Value)'"
  }
}

# ── Extra: nenhuma interação com processo/WMI/Scheduler/jobs globais de fato
# acontece nestes testes (exceto o processo descartavel da secao P4) ────
Teste 'extra. nenhum teste desta suite chamou WMI/Scheduler/jobs globais reais (todos os scriptblocks foram substituidos)' {
  $textoDoProprioArquivo = Get-Content -Raw $PSCommandPath
  $chamadas = [regex]::Matches($textoDoProprioArquivo, 'Invoke-SyncFinanceiroLigar\s+-Raiz')
  Assert-True ($chamadas.Count -ge 5) 'esperava varias chamadas reais a Invoke-SyncFinanceiroLigar neste arquivo de teste'
  foreach ($m in $chamadas) {
    $trechoAposChamada = $textoDoProprioArquivo.Substring($m.Index, [Math]::Min(700, $textoDoProprioArquivo.Length - $m.Index))
    Assert-True ($trechoAposChamada -match '-ObterTarefa') 'toda chamada a Invoke-SyncFinanceiroLigar neste arquivo precisa injetar -ObterTarefa fake'
  }
  $textoDoProprioArquivoSemComentarios = Remove-LinhasDeComentarioPs1 -Texto $textoDoProprioArquivo
  $cmdletWmiReal = 'Get-Cim' + 'Instance'
  Assert-True ($textoDoProprioArquivoSemComentarios -notmatch $cmdletWmiReal) 'este arquivo de teste nao pode chamar o cmdlet WMI real em lugar nenhum (mencao em comentario/titulo e permitida)'
  $cmdletJobReal = 'Get-' + 'Job'
  Assert-True ($textoDoProprioArquivoSemComentarios -notmatch "$cmdletJobReal(\s|\()") 'este arquivo de teste nao pode CHAMAR o cmdlet de enumeracao global de jobs em lugar nenhum (achado real: pode falhar por acesso negado em ambientes restritos)'
  $nomeDoScriptRealDoWorker = 'sync-financeiro' + '-legado'
  Assert-True ($textoDoProprioArquivoSemComentarios -notmatch $nomeDoScriptRealDoWorker) 'este arquivo de teste nunca pode passar o script real do worker pra Start-SyncFinanceiroWorkerProcesso'
}

Write-Output ''
Write-Output "=== $($script:totalTestes) testes, $($script:totalTestes - $script:falhas) OK, $($script:falhas) FAIL ==="
if ($script:falhas -gt 0) { exit 1 } else { exit 0 }
