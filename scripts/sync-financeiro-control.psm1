# Fase 2E — lógica central de controle do worker financeiro (parar/ligar),
# extraída de 4-PARAR.bat/3-LIGAR.bat/watchdog-sync-financeiro.ps1 pra ficar
# testável sem tocar a Tarefa Agendada real, sem matar processo real e sem
# privilégio administrativo.
#
# CORRECAO FASE 2E (2ª rodada) — revisão independente apontou que o critério
# de sucesso ainda dependia de Get-CimInstance Win32_Process/CommandLine, que
# neste ambiente S4U já demonstrou não enxergar os processos de forma
# confiável: uma lista vazia significa "não observável a partir desta
# sessão", NUNCA "parado". A WMI feita pela sessão interativa (Parar/Ligar)
# NUNCA MAIS decide Sucesso — ela só aparece em campos claramente rotulados
# "diagnostico"/"nao autoritativo".
#
# CORRECAO FASE 2E (5ª rodada) — revisão independente substituiu por
# completo o esquema de "identidade" (PID+StartTime com tolerância de 1s,
# arquivo removido em paradas normais) por uma MÁQUINA DE ESTADOS explícita
# e persistente. Motivos:
#   (a) "arquivo presente/ausente" não distinguia "nunca inicializado" de
#       "inicializado, mas corrompido/apagado por engano" — os dois
#       precisam bloquear igualmente, mas a rodada anterior tratava
#       ausência como "pode fazer bootstrap", contradizendo a alegação de
#       janela autolimitada (toda parada removia o arquivo, então toda
#       geração seguinte voltava a depender do fallback WMI).
#   (b) tolerância de 1s na comparação de StartTime podia, em teoria,
#       confundir um PID reaproveitado rapidamente. Trocado por
#       comparação exata de ticks em UTC.
#
# CORRECAO FASE 2E (6ª rodada) — revisão independente apontou que a
# escrita atômica do JSON (temp+Move-Item) NÃO tornava atômico o ciclo
# ler/decidir/gravar: duas gerações podiam ler "Stopped" ao mesmo tempo e
# as DUAS decidirem reivindicar Starting. Mudanças:
#   (a) EXCLUSÃO MÚTUA REAL cross-process/cross-sessão via
#       Invoke-SyncFinanceiroComLockEstado (arquivo fixo aberto com
#       FileShare.None, liberado automaticamente pelo SO se o processo
#       morrer). A decisão "seguro iniciar" e a reivindicação de Starting
#       viraram uma ÚNICA operação sob o mesmo lock, sem intervalo entre
#       elas (ver Invoke-SyncFinanceiroWatchdogInicio) - verificado com um
#       teste de concorrência REAL entre dois processos powershell.exe
#       descartáveis disputando o mesmo diretório.
#   (b) o bypass genérico "-Inicial" foi removido dos caminhos normais -
#       Set-SyncFinanceiroEstadoWorker agora SEMPRE checa ownership; a
#       única reivindicação sem dono prévio é a seção crítica dedicada
#       dentro de Invoke-SyncFinanceiroWatchdogInicio, e o bootstrap tem
#       sua própria operação dedicada (Initialize-SyncFinanceiroEstadoWorker),
#       ambas também protegidas pelo lock. Desfazimento usa a escrita
#       protegida normal (a geração que desfaz já é dona por construção).
#   (c) o ACK passou a ser tratado como o ÚLTIMO registro de "commit": pra
#       Ligar, heartbeat (e outros artefatos falíveis) são gravados ANTES
#       do ACK Rodando, que é sempre o último passo
#       (Invoke-SyncFinanceiroWatchdogConfirmarInicio); pra Parar, a nova
#       Invoke-SyncFinanceiroWatchdogPararEConfirmar persiste Estado=Stopped
#       e só publica o ACK Parado se essa persistência teve sucesso -
#       nunca publica ACK sobre um estado que não foi de fato salvo.
#   (d) Invoke-SyncFinanceiroWatchdogDesfazerPartida agora captura PID/
#       StartTimeUtc ANTES de tentar parar, e NUNCA descarta (Dispose) um
#       handle cuja morte não foi confirmada - devolve o handle ainda
#       vivo pro chamador continuar tentando, gravando Unknown (com a
#       identidade preservada) em vez de Stopped.
#   (e) Stop-SyncFinanceiroWorkerTracking usa Remove-Job -Job (referência
#       direta do PSEventJob), nunca -Name, evitando a resolução por busca
#       no repositório GLOBAL de jobs (que inclui o adaptador
#       PSScheduledJob e pode gerar avisos/acesso negado em ambientes
#       restritos mesmo sem o código nunca chamar Get-Job).
#   (f) leitura da máquina de estados valida ProtocolVersion=1
#       explicitamente - ausente, zero ou qualquer outra versão vira
#       Unknown e bloqueia start.
#
# ── MÁQUINA DE ESTADOS (logs\sync-financeiro.worker-state.json) ──────────
#   { ProtocolVersion, Estado, GeracaoId, Pid, StartTimeUtc, AtualizadoEm }
#   Estado ∈ { Starting, Running, Stopping, Stopped, Unknown }
#
#   - Starting: uma geração reivindicou o direito de iniciar um worker
#     (grava ANTES de chamar Start-SyncFinanceiroWorkerProcesso). NUNCA
#     autoriza outra geração a iniciar (pode ser uma partida em andamento).
#   - Running: worker confirmado de pé (Pid+StartTimeUtc+GeracaoId
#     obrigatórios). Só uma geração nova pode decidir iniciar OUTRO worker
#     depois de verificar - via PID+StartTimeUtc EXATOS, nunca WMI/
#     CommandLine - que o processo Running não existe mais (ou é outro
#     processo, PID reaproveitado) e, se ainda existir de verdade,
#     encerrá-lo e RECONFIRMAR antes de considerar seguro prosseguir.
#   - Stopping: uma geração está no meio de encerrar o worker. NUNCA
#     autoriza start (pode ser uma parada em andamento que ainda não
#     confirmou o resultado).
#   - Stopped: worker confirmado morto. ÚNICO estado (além de um Running
#     que a reconciliação consiga verificar como morto) que autoriza uma
#     nova geração a iniciar. Escrito depois de confirmar a morte do Node
#     - o arquivo NUNCA é apagado numa parada normal, só atualizado.
#   - Unknown: estado não pôde ser determinado com confiança (arquivo
#     ausente, corrompido, ou Running sem os campos obrigatórios). NUNCA
#     autoriza start automaticamente - fail-safe.
#
#   Ausência do arquivo (nunca inicializado OU inicializado e depois
#   sumiu) e conteúdo corrompido são tratados de forma UNIFICADA como
#   bloqueio (ambos aparecem como Estado=Unknown na leitura) - o único
#   jeito de sair desse bloqueio inicial é a etapa de BOOTSTRAP explícita
#   (Initialize-SyncFinanceiroEstadoWorker, ver mais abaixo), nunca uma
#   ação automática do watchdog.
#
#   Ownership: uma geração só pode ALTERAR um estado que já pertence a ela
#   (mesmo GeracaoId no arquivo atual) - ver Set-SyncFinanceiroEstadoWorker.
#   A ÚNICA escrita que não exige isso é a reivindicação inicial de
#   Starting (-Inicial), que é o próprio ato de uma geração se tornar dona
#   - e só acontece depois que Invoke-SyncFinanceiroWatchdogInicio já
#   confirmou, via o estado atual, que é seguro prosseguir.
#
# ── BOOTSTRAP (1ª inicialização do protocolo, leia antes de fazer deploy) ─
# O protocolo de estados começa "inexistente" - NADA no código o inicializa
# automaticamente (ausência de arquivo NUNCA autoriza start, mesmo na
# primeira geração após o deploy; WMI nunca mais autoriza start, só
# permanece como diagnóstico manual). A única forma de sair desse bloqueio
# inicial é rodar Initialize-SyncFinanceiroEstadoWorker (ou o wrapper
# scripts\inicializar-protocolo-estado-worker.ps1) manualmente, UMA VEZ,
# com a confirmação explícita de que nenhum worker antigo está rodando.
#
# Procedimento de release inicial (nesta ordem):
#   1. ANTES do `git pull`, o checkout ainda tem o 4-PARAR.bat ANTIGO
#      (sem o protocolo de estados). Use o procedimento DIRETO já
#      comprovado na Fase 2D: criar logs\sync-financeiro.stop manualmente
#      e confirmar a parada pelos LOGS do supervisor
#      (logs\sync-financeiro-supervisor.log), nunca pelo protocolo novo
#      (que ainda não existe no código rodando nesse momento).
#   2. `git pull` (traz o código desta versão, com o protocolo de
#      estados).
#   3. SÓ ENTÃO rodar Initialize-SyncFinanceiroEstadoWorker (ou o
#      wrapper scripts\inicializar-protocolo-estado-worker.ps1), com a
#      confirmação explícita de que o passo 1 já confirmou que nada está
#      rodando - isso grava Estado=Stopped pela primeira vez.
#   4. 3-LIGAR.bat normalmente a partir daqui.
# Depois do bootstrap: ausência ou corrupção do estado volta a BLOQUEAR o
# start (nunca vira bootstrap automático de novo) - Initialize-* se recusa
# a rodar uma segunda vez enquanto já existir um arquivo de estado (mesmo
# Unknown/corrompido), então uma corrupção acidental depois do bootstrap
# exige intervenção manual deliberada, não um re-run cego deste script.
#
# Protocolo de confirmação de pedidos (Parar/Ligar - Fase 2E, 2ª/3ª rodada,
# inalterado nesta rodada):
#   - logs\sync-financeiro.stop     (persistente; só 3-LIGAR remove) —
#     JSON { RequestId, CriadoEm }. Presença do ARQUIVO (independente do
#     conteúdo dar parse) já é suficiente pra decidir "não iniciar worker" —
#     fail-safe sempre na direção de parar, nunca na de rodar.
#   - logs\sync-financeiro.request  — JSON { RequestId, Tipo, CriadoEm },
#     escrito por Parar/Ligar ANTES de agir. É o "pedido atual" que o
#     watchdog deve responder.
#   - logs\sync-financeiro.ack      — JSON { RequestId, Tipo, Estado, Pid,
#     AtualizadoEm }. Só o WATCHDOG escreve (ele é quem tem o handle real do
#     processo filho — Wait/HasExited no próprio $proc, nunca WMI). Parar só
#     aceita Sucesso quando RequestId do ack bate com o RequestId que ELE
#     mesmo gerou nesta chamada — um ack antigo (RequestId diferente) nunca é
#     aceito só porque o arquivo existe.
#   - logs\sync-financeiro.heartbeat — JSON { Estado, Pid, AtualizadoEm },
#     atualizado pelo watchdog a cada volta do loop enquanto vivo. Usado
#     APENAS como sinal auxiliar de "watchdog vivo e respondendo" pro caso
#     idempotente do Ligar — nunca usado pelo lado do Parar pra concluir
#     "parado", e nunca substitui a máquina de estados acima (que é sobre o
#     PROCESSO em si, não sobre pedidos individuais).
#
# Nenhuma função aqui usa -ErrorAction SilentlyContinue em operação que
# decide sucesso — em especial Remove-SyncFinanceiroFlag (a remoção do
# sinalizador é verificada por Test-Path depois da tentativa, não assumida)
# e a escrita/leitura de request/ack/heartbeat/estado (escrita sempre com
# -ErrorAction Stop, propagando exceção real pro chamador).
#
# Todas as funções que tocam Scheduler/processo real aceitam um scriptblock
# de override (-ObterTarefa/-Iniciar/-Dormir/-ObterProcessoPorId/
# -EncerrarProcesso) — os testes passam fakes; os scripts de produção usam
# os defaults reais definidos abaixo, no escopo do módulo.

# Escopo idêntico ao já usado antes pra limpeza legada — nunca "node.exe"
# genérico, só o processo do worker real. Mantido só como fonte de
# DIAGNÓSTICO manual (Invoke-SyncFinanceiroLimpezaLegadoWmi) — nunca decide
# Sucesso/DeveIniciarWorker em lugar nenhum a partir desta rodada.
$script:ObterProcessosPadrao = {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'sync-financeiro-legado\.mjs' -and $_.CommandLine -match '--watch' }
}
$script:IniciarTarefaPadrao = { param($nome) Start-ScheduledTask -TaskName $nome -ErrorAction Stop }
# -ErrorAction Stop (nao mais SilentlyContinue): acesso negado na consulta
# precisa continuar sendo "acesso negado" pra quem chama, nunca virar
# silenciosamente "tarefa inexistente" (ver Get-SyncFinanceiroTarefaEstado).
$script:ObterTarefaPadrao = { param($nome) Get-ScheduledTask -TaskName $nome -ErrorAction Stop }
$script:DormirPadrao = { param($segundos) Start-Sleep -Seconds $segundos }

# Devolve o objeto do processo (com .Id/.StartTime) pra um PID, ou $null
# se NAO existir - "nao existe" (mensagem padrao do Get-Process) e um
# resultado NORMAL/esperado, nunca um erro escondido; qualquer OUTRA
# excecao (consulta genuinamente falhando) propaga.
$script:ObterProcessoPorIdPadrao = {
  param($ProcessId)
  try {
    Get-Process -Id $ProcessId -ErrorAction Stop
  } catch {
    if ($_.Exception.Message -match '(?i)cannot find a process') { return $null }
    throw
  }
}
$script:EncerrarProcessoPadrao = { param($ProcessId) Stop-Process -Id $ProcessId -Force -ErrorAction Stop }

# ── Helpers internos de JSON (não exportados) ────────────────────────────
# Escrita sempre atômica (escreve em arquivo temporário e só então
# Move-Item -Force pro nome final) — evita leitor concorrente ver conteúdo
# parcial. Sempre -ErrorAction Stop: uma falha real de escrita PRECISA
# propagar (nunca vira sucesso silencioso).
function Write-SyncFinanceiroJsonArquivo {
  param([Parameter(Mandatory)][string]$Caminho, [Parameter(Mandatory)]$Objeto)
  $pasta = Split-Path -Parent $Caminho
  New-Item -ItemType Directory -Force -Path $pasta | Out-Null
  $temp = "$Caminho.tmp." + [guid]::NewGuid().ToString('N')
  ($Objeto | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $temp -Encoding utf8 -ErrorAction Stop
  Move-Item -LiteralPath $temp -Destination $Caminho -Force -ErrorAction Stop
}

# Leitura tolerante: arquivo ausente OU conteúdo corrompido viram $null.
# NUNCA causa falso-positivo de sucesso — quem chama trata $null
# explicitamente (ver Get-SyncFinanceiroEstadoWorkerAtual, que mapeia
# ambos os casos pra Estado=Unknown, nunca pra "pode iniciar").
function Read-SyncFinanceiroJsonArquivo {
  param([Parameter(Mandatory)][string]$Caminho)
  if (-not (Test-Path -LiteralPath $Caminho)) { return $null }
  try {
    $texto = Get-Content -Raw -LiteralPath $Caminho -ErrorAction Stop
    if ([string]::IsNullOrWhiteSpace($texto)) { return $null }
    $texto | ConvertFrom-Json -ErrorAction Stop
  } catch {
    $null
  }
}

# ── Caminhos ───────────────────────────────────────────────────────────
function Get-SyncFinanceiroFlagPath { param([Parameter(Mandatory)][string]$Raiz) Join-Path $Raiz 'logs\sync-financeiro.stop' }
function Get-SyncFinanceiroRequestPath { param([Parameter(Mandatory)][string]$Raiz) Join-Path $Raiz 'logs\sync-financeiro.request' }
function Get-SyncFinanceiroAckPath { param([Parameter(Mandatory)][string]$Raiz) Join-Path $Raiz 'logs\sync-financeiro.ack' }
function Get-SyncFinanceiroHeartbeatPath { param([Parameter(Mandatory)][string]$Raiz) Join-Path $Raiz 'logs\sync-financeiro.heartbeat' }
function Get-SyncFinanceiroEstadoPath { param([Parameter(Mandatory)][string]$Raiz) Join-Path $Raiz 'logs\sync-financeiro.worker-state.json' }
function Get-SyncFinanceiroLockPath { param([Parameter(Mandatory)][string]$Raiz) Join-Path $Raiz 'logs\sync-financeiro.worker-state.lock' }

# ── Exclusão mútua REAL entre gerações/processos (Fase 2E, 6ª rodada) ────
# A escrita atômica do JSON (temp+Move-Item) só garante que um LEITOR nunca
# vê conteúdo parcial - ela NÃO torna atômico o ciclo ler/decidir/gravar.
# Duas gerações podem, sem isso, ler "Stopped" ao mesmo tempo e as DUAS
# decidirem que é seguro reivindicar Starting. Este lock resolve isso com
# um arquivo FIXO (nunca o nome muda) aberto com FileShare.None: o SO só
# deixa um processo por vez manter o handle aberto, então é uma seção
# crítica cross-process e cross-sessão de verdade (não apenas dentro do
# mesmo processo PowerShell). Não usa Mutex nomeado do .NET de propósito -
# um FileStream com FileShare.None tem a MESMA garantia de exclusão e,
# crucialmente, é liberado automaticamente pelo SO se o processo morrer
# (crash, kill -9, etc.) sem precisar de nenhum cleanup especial - não há
# "mutex abandonado" pra detectar/tratar.
function Invoke-SyncFinanceiroComLockEstado {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][scriptblock]$Corpo,
    [int]$TimeoutSegundos = 30,
    [int]$IntervaloTentativaMilissegundos = 100
  )
  $caminhoLock = Get-SyncFinanceiroLockPath -Raiz $Raiz
  $pasta = Split-Path -Parent $caminhoLock
  New-Item -ItemType Directory -Force -Path $pasta | Out-Null
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $stream = $null
  try {
    while ($true) {
      try {
        $stream = [System.IO.File]::Open($caminhoLock, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
        break
      } catch [System.IO.IOException] {
        if ($sw.Elapsed.TotalSeconds -ge $TimeoutSegundos) {
          throw "nao consegui adquirir o lock de estado '$caminhoLock' dentro de ${TimeoutSegundos}s - outro processo/geracao mantem o arquivo aberto (FileShare.None): $($_.Exception.Message)"
        }
        Start-Sleep -Milliseconds $IntervaloTentativaMilissegundos
      }
    }
    # O handle FICA aberto (FileShare.None) durante TODO o corpo - releitura,
    # decisao e gravacao acontecem sob a MESMA secao critica, sem intervalo
    # onde outro processo pudesse abrir o mesmo arquivo de estado.
    & $Corpo
  } finally {
    # SEMPRE liberado, mesmo se o corpo lancar - nunca deixa o lock preso
    # por uma excecao no meio da secao critica.
    if ($stream) { try { $stream.Dispose() } catch {} }
  }
}

# ── Lock de INSTÂNCIA do supervisor (Fase 2E, 7ª rodada) ─────────────────
# Achado da revisão: Invoke-SyncFinanceiroComLockEstado protege só a
# TRANSICAO (ler/decidir/gravar), liberado em segundos - ele NÃO impede uma
# SEGUNDA instância do watchdog (ex.: dois disparos do Scheduler
# sobrepostos) de coexistir depois que a primeira já chegou a Running: a
# segunda, ao rodar sua própria seção crítica, veria Running, reconciliaria
# (achando o processo saudável vivo) e - dependendo da timing - poderia
# achar necessário encerrá-lo. Este lock é um arquivo FIXO SEPARADO
# (nunca o mesmo do lock de transição), mantido aberto (FileShare.None)
# da PRIMEIRA linha até a SAÍDA do supervisor inteiro - não é liberado e
# reaadquirido a cada geração, ao contrário do lock de estado. Uma
# segunda instância que não consiga adquiri-lo tem que sair IMEDIATAMENTE,
# sem chamar reconciliação/decisão de início nenhuma (nunca reconcilia,
# mata ou inicia worker nenhum). Liberado automaticamente pelo SO se o
# processo morrer (crash, kill -9, Task Scheduler encerrando à força) -
# mesma garantia do lock de transição, sem cleanup especial necessário.
function Get-SyncFinanceiroLockInstanciaPath { param([Parameter(Mandatory)][string]$Raiz) Join-Path $Raiz 'logs\sync-financeiro.instance.lock' }

# Tentativa ÚNICA, não-bloqueante - se outra instância já mantém o lock
# aberto, devolve Adquirido=$false imediatamente (nunca espera/faz
# polling: o chamador é o PONTO DE ENTRADA do supervisor, e esperar aqui
# significaria potencialmente competir de forma ambígua com uma instância
# que pode estar prestes a sair sozinha - mais simples e mais seguro sair
# já e deixar o próximo disparo natural do Scheduler tentar de novo).
# Devolve o Stream ABERTO pro chamador manter vivo por toda a vida do
# processo - NUNCA deve ser fechado explicitamente antes da saída
# definitiva do supervisor (o SO libera sozinho na saída do processo).
function Invoke-SyncFinanceiroAdquirirLockInstancia {
  param([Parameter(Mandatory)][string]$Raiz)
  $caminho = Get-SyncFinanceiroLockInstanciaPath -Raiz $Raiz
  $pasta = Split-Path -Parent $caminho
  New-Item -ItemType Directory -Force -Path $pasta | Out-Null
  try {
    $stream = [System.IO.File]::Open($caminho, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
    [pscustomobject]@{ Adquirido = $true; Stream = $stream; Erro = $null }
  } catch {
    [pscustomobject]@{ Adquirido = $false; Stream = $null; Erro = $_.Exception.Message }
  }
}

# Liberação explícita - só usada em testes/cenários de curta duração que
# precisam liberar o lock de instância sem esperar o processo terminar
# (o supervisor real NUNCA chama isto - ele sai do processo inteiro, e o
# SO libera sozinho).
function Close-SyncFinanceiroLockInstancia {
  param($Resultado)
  if ($Resultado -and $Resultado.Stream) { try { $Resultado.Stream.Dispose() } catch {} }
}

# ── Sinalizador de parada ─────────────────────────────────────────────
function Test-SyncFinanceiroFlagPresente {
  param([Parameter(Mandatory)][string]$Raiz)
  Test-Path -LiteralPath (Get-SyncFinanceiroFlagPath -Raiz $Raiz)
}

# Idempotente: criar de novo sobre um sinalizador já existente não é erro
# (cenário "parar duas vezes" precisa ser seguro) — sempre GRAVA o
# RequestId novo por cima, pra que o watchdog responda ao pedido mais
# recente.
function New-SyncFinanceiroFlag {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [string]$RequestId,
    [datetime]$CriadoEm = (Get-Date)
  )
  Write-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroFlagPath -Raiz $Raiz) -Objeto ([pscustomobject]@{
    RequestId = $RequestId
    CriadoEm  = $CriadoEm.ToString('o')
  })
}

# Devolve um objeto com Sucesso/Erro explícitos — NUNCA usa
# -ErrorAction SilentlyContinue. Verifica a pós-condição real (Test-Path
# depois de tentar remover), não assume sucesso só porque Remove-Item não
# lançou. Idempotente: sinalizador já ausente não é erro.
function Remove-SyncFinanceiroFlag {
  param([Parameter(Mandatory)][string]$Raiz)
  $caminho = Get-SyncFinanceiroFlagPath -Raiz $Raiz
  if (Test-Path -LiteralPath $caminho) {
    try {
      Remove-Item -LiteralPath $caminho -Force -ErrorAction Stop
    } catch {
      return [pscustomobject]@{ Sucesso = $false; Erro = $_.Exception.Message }
    }
  }
  if (Test-Path -LiteralPath $caminho) {
    return [pscustomobject]@{ Sucesso = $false; Erro = 'sinalizador ainda presente apos a tentativa de remocao (causa desconhecida)' }
  }
  [pscustomobject]@{ Sucesso = $true; Erro = $null }
}

# Leitura best-effort do CONTEÚDO do sinalizador (pode ser $null mesmo com
# o arquivo presente, se o JSON estiver corrompido) — só usada pra tentar
# recuperar o RequestId a marcar no ack. A decisão "deve iniciar worker?"
# NUNCA depende disso, só de Test-SyncFinanceiroFlagPresente (presença do
# arquivo), pra ficar fail-safe mesmo com conteúdo ilegível.
function Get-SyncFinanceiroFlagInfo {
  param([Parameter(Mandatory)][string]$Raiz)
  Read-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroFlagPath -Raiz $Raiz)
}

# ── Pedido atual (request) ────────────────────────────────────────────
function Write-SyncFinanceiroRequest {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)][ValidateSet('Parar', 'Ligar')][string]$Tipo,
    [datetime]$CriadoEm = (Get-Date)
  )
  Write-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroRequestPath -Raiz $Raiz) -Objeto ([pscustomobject]@{
    RequestId = $RequestId
    Tipo      = $Tipo
    CriadoEm  = $CriadoEm.ToString('o')
  })
}
function Get-SyncFinanceiroRequestAtual {
  param([Parameter(Mandatory)][string]$Raiz)
  Read-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroRequestPath -Raiz $Raiz)
}

# Resolve qual RequestId de PARADA o watchdog deve usar pra marcar o ack:
# preferindo o token gravado no próprio sinalizador (mais direto) e caindo
# pro arquivo de request (Tipo=Parar) só se o sinalizador não tiver um
# token legível. Pode devolver $null (sinalizador presente mas sem token
# em lugar nenhum) — quem chama trata isso graciosamente (não inicia
# worker mesmo assim, só não consegue marcar QUAL pedido foi atendido).
function Get-SyncFinanceiroRequestIdDeParada {
  param([Parameter(Mandatory)][string]$Raiz)
  $flagInfo = Get-SyncFinanceiroFlagInfo -Raiz $Raiz
  if ($flagInfo -and $flagInfo.RequestId) { return $flagInfo.RequestId }
  $reqAtual = Get-SyncFinanceiroRequestAtual -Raiz $Raiz
  if ($reqAtual -and $reqAtual.Tipo -eq 'Parar' -and $reqAtual.RequestId) { return $reqAtual.RequestId }
  $null
}

# ── Confirmação (ack) — só o watchdog escreve ─────────────────────────
function Write-SyncFinanceiroAck {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [string]$RequestId,
    [Parameter(Mandatory)][ValidateSet('Parar', 'Ligar')][string]$Tipo,
    [Parameter(Mandatory)][ValidateSet('Parado', 'Rodando')][string]$Estado,
    $WorkerPid,
    [datetime]$AtualizadoEm = (Get-Date)
  )
  Write-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroAckPath -Raiz $Raiz) -Objeto ([pscustomobject]@{
    RequestId    = $RequestId
    Tipo         = $Tipo
    Estado       = $Estado
    Pid          = $WorkerPid
    AtualizadoEm = $AtualizadoEm.ToString('o')
  })
}
function Get-SyncFinanceiroAckAtual {
  param([Parameter(Mandatory)][string]$Raiz)
  Read-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroAckPath -Raiz $Raiz)
}

# ── Heartbeat — sinal auxiliar de "watchdog vivo", só apoia o caso
# idempotente do Ligar (ver nota grande no topo do arquivo) ──────────────
function Write-SyncFinanceiroHeartbeat {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][ValidateSet('Iniciando', 'Rodando', 'Parado')][string]$Estado,
    $WorkerPid,
    [datetime]$AtualizadoEm = (Get-Date)
  )
  Write-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroHeartbeatPath -Raiz $Raiz) -Objeto ([pscustomobject]@{
    Estado       = $Estado
    Pid          = $WorkerPid
    AtualizadoEm = $AtualizadoEm.ToString('o')
  })
}
function Get-SyncFinanceiroHeartbeatAtual {
  param([Parameter(Mandatory)][string]$Raiz)
  Read-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroHeartbeatPath -Raiz $Raiz)
}
function Test-SyncFinanceiroHeartbeatFresco {
  param([Parameter(Mandatory)][string]$Raiz, [int]$MaxIdadeSegundos = 15)
  $hb = Get-SyncFinanceiroHeartbeatAtual -Raiz $Raiz
  if (-not $hb -or -not $hb.AtualizadoEm) { return $false }
  try { $ts = [datetime]$hb.AtualizadoEm } catch { return $false }
  ((Get-Date) - $ts).TotalSeconds -le $MaxIdadeSegundos
}

# ── Diagnóstico WMI (NUNCA autoritativo, NUNCA decide start — ver nota
# grande no topo) ─────────────────────────────────────────────────────
function Get-SyncFinanceiroWorkerProcessos {
  param([scriptblock]$ObterProcessos = $script:ObterProcessosPadrao)
  # -NoEnumerate é essencial aqui: sem isso, o pipeline de saída de uma
  # função PowerShell "desembrulha" um array de exatamente 1 elemento de
  # volta pra um objeto escalar (mesmo com @() explícito dentro da
  # função) — quem chamar .Count no resultado quando houver exatamente 1
  # processo receberia $null em vez de 1. Achado real, pego pelo teste 6
  # da 1ª rodada desta fase.
  Write-Output -NoEnumerate @(& $ObterProcessos)
}

# Mantida só como utilitário de diagnóstico pontual — NUNCA chamada pelos
# orquestradores (Invoke-SyncFinanceiroParar/Ligar) pra decidir Sucesso.
function Test-SyncFinanceiroPararConfirmado {
  param([scriptblock]$ObterProcessos = $script:ObterProcessosPadrao)
  (Get-SyncFinanceiroWorkerProcessos -ObterProcessos $ObterProcessos).Count -eq 0
}

# Limpeza LEGADA (WMI/CommandLine) — mantida SÓ como utilitário de
# DIAGNÓSTICO manual (nunca chamada pelo caminho de decisão a partir desta
# rodada: a máquina de estados substituiu WMI como fonte de verdade sobre
# workers anteriores). Consultas CIM com -ErrorAction Stop (nunca
# SilentlyContinue) — uma falha real da consulta vira Sucesso=$false
# explícito, nunca uma lista vazia enganosa. -Log é opcional (default
# silencioso) só pra dar visibilidade no log real do watchdog.
function Invoke-SyncFinanceiroLimpezaLegadoWmi {
  param([scriptblock]$Log = { param($msg) })
  try {
    $candidatosNode = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -match 'sync-financeiro-legado\.mjs' })
    foreach ($c in $candidatosNode) {
      try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; & $Log "orfao (legado, diagnostico) node.exe PID $($c.ProcessId) encerrado" }
      catch { & $Log "nao consegui encerrar orfao (legado, diagnostico) node.exe PID $($c.ProcessId): $($_.Exception.Message)" }
    }
    $candidatosCmd = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -match 'sync-financeiro-legado\.mjs' })
    foreach ($c in $candidatosCmd) {
      try { Stop-Process -Id $c.ProcessId -Force -ErrorAction Stop; & $Log "orfao (legado, diagnostico) cmd.exe PID $($c.ProcessId) encerrado" }
      catch { & $Log "nao consegui encerrar orfao (legado, diagnostico) cmd.exe PID $($c.ProcessId): $($_.Exception.Message)" }
    }
    if ($candidatosNode.Count -gt 0 -or $candidatosCmd.Count -gt 0) { Start-Sleep -Milliseconds 500 }
    $restantes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
        Where-Object { $_.CommandLine -match 'sync-financeiro-legado\.mjs' })
    [pscustomobject]@{ Sucesso = ($restantes.Count -eq 0); ProcessosRestantes = $restantes.Count; Erro = $null }
  } catch {
    [pscustomobject]@{ Sucesso = $false; ProcessosRestantes = -1; Erro = $_.Exception.Message }
  }
}

# ── Poll genérico — nunca usa timeout.exe/PATH, só Start-Sleep (ou o
# substituto injetado pelos testes, pra não gastar tempo real) ───────────
function Wait-SyncFinanceiroCondicao {
  param(
    [Parameter(Mandatory)][scriptblock]$Condicao,
    [int]$TimeoutSegundos = 30,
    [int]$IntervaloSegundos = 2,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  $decorridos = 0
  while ($true) {
    if (& $Condicao) { return $true }
    if ($decorridos -ge $TimeoutSegundos) { return $false }
    & $Dormir $IntervaloSegundos
    $decorridos += $IntervaloSegundos
  }
}

# ── Orquestração: PARAR ───────────────────────────────────────────────
# Gera um RequestId novo, grava o pedido, arma o sinalizador (persistente,
# idempotente) já carregando esse RequestId, e aciona a Tarefa Agendada
# como "empurrão" pra garantir que existe uma geração de watchdog viva pra
# responder (idempotente — se já havia uma rodando, ela mesma responde
# pelo polling normal; se não, a nova geração vê o sinalizador antes de
# iniciar qualquer worker e confirma na hora). Só reporta Sucesso quando o
# WATCHDOG grava um ack com Estado=Parado E o MESMO RequestId gerado
# aqui — nunca aceita um ack antigo só porque o arquivo existe, e nunca
# usa a contagem WMI (ObterProcessos) pra decidir isso.
function Invoke-SyncFinanceiroParar {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [string]$NomeTarefa = 'VivenzzaSyncFinanceiroLegado',
    [int]$TimeoutSegundos = 30,
    [int]$IntervaloSegundos = 2,
    [scriptblock]$ObterProcessos = $script:ObterProcessosPadrao,
    [scriptblock]$Iniciar = $script:IniciarTarefaPadrao,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  $requestId = [guid]::NewGuid().ToString()
  Write-SyncFinanceiroRequest -Raiz $Raiz -RequestId $requestId -Tipo 'Parar'
  New-SyncFinanceiroFlag -Raiz $Raiz -RequestId $requestId

  $erroAoAcionar = $null
  try { & $Iniciar $NomeTarefa } catch { $erroAoAcionar = $_.Exception.Message }

  $confirmado = Wait-SyncFinanceiroCondicao `
    -Condicao {
    $ack = Get-SyncFinanceiroAckAtual -Raiz $Raiz
    $ack -and $ack.RequestId -eq $requestId -and $ack.Estado -eq 'Parado'
  } `
    -TimeoutSegundos $TimeoutSegundos -IntervaloSegundos $IntervaloSegundos -Dormir $Dormir

  [pscustomobject]@{
    Sucesso             = $confirmado
    RequestId           = $requestId
    SinalizadorCriado   = $true
    ConfirmacaoWatchdog = Get-SyncFinanceiroAckAtual -Raiz $Raiz
    ErroAoAcionarTarefa = $erroAoAcionar
    # Diagnóstico apenas — WMI/CommandLine já demonstrou não ser confiável
    # neste ambiente (lista vazia pode significar "não observável", não
    # "parado"). NUNCA usar este campo pra decidir nada, só pra log.
    ProcessosRestantes  = (Get-SyncFinanceiroWorkerProcessos -ObterProcessos $ObterProcessos).Count
  }
}

# ── Estado da Tarefa Agendada ──────────────────────────────────────────
# Devolve {Tarefa; NaoEncontrada; Erro} - nunca colapsa "acesso negado" (ou
# qualquer outro erro real de consulta) em "tarefa nao encontrada": so
# classifica como NaoEncontrada quando a tarefa de fato nao existe (devolve
# $null sem lancar, OU lanca uma excecao cuja mensagem bate com o padrao
# real do Get-ScheduledTask pra "nenhuma tarefa encontrada"). Qualquer outro
# erro (ex.: acesso negado) fica em Erro, com a mensagem original intacta.
function Get-SyncFinanceiroTarefaEstado {
  param(
    [Parameter(Mandatory)][string]$NomeTarefa,
    [scriptblock]$ObterTarefa = $script:ObterTarefaPadrao
  )
  try {
    $tarefa = & $ObterTarefa $NomeTarefa
    if (-not $tarefa) {
      return [pscustomobject]@{ Tarefa = $null; NaoEncontrada = $true; Erro = $null }
    }
    [pscustomobject]@{ Tarefa = $tarefa; NaoEncontrada = $false; Erro = $null }
  } catch {
    $msg = $_.Exception.Message
    $naoEncontrada = $msg -match '(?i)no\s+MSFT_ScheduledTask|cannot find|does not exist|nao encontrada|not found'
    [pscustomobject]@{ Tarefa = $null; NaoEncontrada = $naoEncontrada; Erro = $(if ($naoEncontrada) { $null } else { $msg }) }
  }
}

function Start-SyncFinanceiroTarefaAgendada {
  param(
    [Parameter(Mandatory)][string]$NomeTarefa,
    [scriptblock]$Iniciar = $script:IniciarTarefaPadrao
  )
  try {
    & $Iniciar $NomeTarefa
    [pscustomobject]@{ Sucesso = $true; Erro = $null }
  } catch {
    [pscustomobject]@{ Sucesso = $false; Erro = $_.Exception.Message }
  }
}

# ── Orquestração: LIGAR (transacional) ─────────────────────────────────
# Sequencia:
#   1) VALIDACAO SEM MUTACAO: a tarefa precisa existir, ser consultavel e
#      estar habilitada. Acesso negado (ou qualquer erro real de consulta)
#      fica sendo "acesso negado", nunca vira "tarefa nao encontrada" (ver
#      Get-SyncFinanceiroTarefaEstado). Nada e alterado em disco ainda.
#   2) MUTACAO: remove o sinalizador e CONFIRMA a ausencia (Test-Path apos
#      a remocao) — se falhar, aborta ANTES de acionar o Scheduler.
#   3) Gera um RequestId novo, grava o pedido, tenta acionar a tarefa. Erro
#      real do Start-ScheduledTask NAO aborta na hora — uma instancia ja
#      ativa pode responder mesmo assim (idempotente), entao ainda
#      esperamos (janela mais curta) por um ack exato.
#   4) Sucesso EXIGE ack com Estado=Rodando E o MESMO RequestId gerado
#      aqui — nunca aceita heartbeat sozinho, nunca aceita ack de um
#      RequestId diferente. Heartbeat so e usado (ANTES de qualquer
#      mutacao) pra classificar informativamente JaEstavaRodando — nunca
#      pra decidir Sucesso.
#   5) Se o ack exato nao chegar a tempo, RESTAURA o sinalizador
#      (transacional: gera e CONFIRMA a presenca) antes de devolver falha,
#      e informa explicitamente se o rollback foi confirmado. Se o
#      rollback tambem falhar, o resultado reporta AMBAS as causas como
#      "estado indeterminado".
# Nunca chama Enable-ScheduledTask em caminho nenhum.
function Invoke-SyncFinanceiroLigar {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [string]$NomeTarefa = 'VivenzzaSyncFinanceiroLegado',
    [int]$TimeoutSegundos = 30,
    [int]$TimeoutSegundosSeFalhaAoAcionar = 10,
    [int]$IntervaloSegundos = 2,
    [int]$HeartbeatMaxIdadeSegundos = 15,
    [scriptblock]$ObterTarefa = $script:ObterTarefaPadrao,
    [scriptblock]$Iniciar = $script:IniciarTarefaPadrao,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  # Classificacao PURAMENTE informativa (nunca decide Sucesso), avaliada
  # ANTES de qualquer mutacao - reflete o estado de antes desta chamada.
  $jaEstavaRodandoAntes = $false
  if (Test-SyncFinanceiroHeartbeatFresco -Raiz $Raiz -MaxIdadeSegundos $HeartbeatMaxIdadeSegundos) {
    $hbAntes = Get-SyncFinanceiroHeartbeatAtual -Raiz $Raiz
    if ($hbAntes -and $hbAntes.Estado -eq 'Rodando') { $jaEstavaRodandoAntes = $true }
  }

  # 1) VALIDACAO SEM MUTACAO
  $estadoTarefa = Get-SyncFinanceiroTarefaEstado -NomeTarefa $NomeTarefa -ObterTarefa $ObterTarefa
  if ($estadoTarefa.Erro -and -not $estadoTarefa.NaoEncontrada) {
    return [pscustomobject]@{
      Sucesso = $false; JaEstavaRodando = $false; RequestId = $null; RollbackConfirmado = $null
      Erro    = "nao consegui consultar a Tarefa Agendada '$NomeTarefa' (sinalizador preservado, Scheduler NAO acionado): $($estadoTarefa.Erro)"
    }
  }
  if (-not $estadoTarefa.Tarefa) {
    return [pscustomobject]@{
      Sucesso = $false; JaEstavaRodando = $false; RequestId = $null; RollbackConfirmado = $null
      Erro    = "Tarefa Agendada '$NomeTarefa' nao encontrada (sinalizador preservado) - rode a instalacao administrativa (scripts\instalar-tarefa-sync-financeiro.ps1) como Administrador"
    }
  }
  if ($estadoTarefa.Tarefa.State -eq 'Disabled') {
    return [pscustomobject]@{
      Sucesso = $false; JaEstavaRodando = $false; RequestId = $null; RollbackConfirmado = $null
      Erro    = "Tarefa Agendada '$NomeTarefa' esta Disabled (sinalizador preservado) - nao vou reabilita-la automaticamente; rode a instalacao/reparo administrativo (scripts\instalar-tarefa-sync-financeiro.ps1) como Administrador"
    }
  }

  # 2) MUTACAO: remove e CONFIRMA a ausencia antes de seguir.
  $removido = Remove-SyncFinanceiroFlag -Raiz $Raiz
  if (-not $removido.Sucesso) {
    return [pscustomobject]@{
      Sucesso = $false; JaEstavaRodando = $false; RequestId = $null; RollbackConfirmado = $null
      Erro    = "falha ao remover o sinalizador de parada (abortando ANTES de acionar a Tarefa Agendada): $($removido.Erro)"
    }
  }

  $requestId = [guid]::NewGuid().ToString()
  Write-SyncFinanceiroRequest -Raiz $Raiz -RequestId $requestId -Tipo 'Ligar'

  $erroIniciar = $null
  try { & $Iniciar $NomeTarefa } catch { $erroIniciar = $_.Exception.Message }

  # Mesmo com erro no acionamento, aguarda (janela mais curta) pelo ack
  # EXATO - uma instancia ja ativa pode responder e tornar isto idempotente.
  $timeoutEfetivo = if ($erroIniciar) { $TimeoutSegundosSeFalhaAoAcionar } else { $TimeoutSegundos }
  $confirmado = Wait-SyncFinanceiroCondicao `
    -Condicao {
    $ack = Get-SyncFinanceiroAckAtual -Raiz $Raiz
    $ack -and $ack.RequestId -eq $requestId -and $ack.Estado -eq 'Rodando'
  } `
    -TimeoutSegundos $timeoutEfetivo -IntervaloSegundos $IntervaloSegundos -Dormir $Dormir

  if ($confirmado) {
    [pscustomobject]@{ Sucesso = $true; JaEstavaRodando = $jaEstavaRodandoAntes; RequestId = $requestId; RollbackConfirmado = $null; Erro = $null }
    return
  }

  # 5) ROLLBACK TRANSACIONAL: restaura o sinalizador e CONFIRMA a presenca.
  $tokenRollback = [guid]::NewGuid().ToString()
  $rollbackConfirmado = $false
  $erroRollback = $null
  try {
    New-SyncFinanceiroFlag -Raiz $Raiz -RequestId $tokenRollback
    $rollbackConfirmado = Test-SyncFinanceiroFlagPresente -Raiz $Raiz
    if (-not $rollbackConfirmado) { $erroRollback = 'sinalizador nao apareceu no disco apos a tentativa de restauracao' }
  } catch {
    $erroRollback = $_.Exception.Message
  }

  $motivoOriginal = if ($erroIniciar) {
    "falha ao acionar a Tarefa Agendada ($erroIniciar) e nenhuma instancia ja ativa confirmou (ack exato) dentro do prazo"
  } else {
    'tarefa acionada, mas nenhum ack com Estado=Rodando e este RequestId chegou dentro do prazo'
  }

  $erroFinal = if ($rollbackConfirmado) {
    "$motivoOriginal. Sinalizador de parada RESTAURADO e CONFIRMADO (rollback ok)."
  } else {
    "$motivoOriginal. ADICIONALMENTE o rollback do sinalizador FALHOU ($erroRollback) - ESTADO INDETERMINADO: nao sabemos se o worker esta parado ou rodando, e o sinalizador pode nao estar protegendo o estado esperado. Intervencao manual necessaria."
  }

  [pscustomobject]@{ Sucesso = $false; JaEstavaRodando = $false; RequestId = $requestId; RollbackConfirmado = $rollbackConfirmado; Erro = $erroFinal }
}

# Usado nos pontos onde o watchdog encontra o sinalizador SEM ter um
# worker vivo sob seu handle no momento (antes de tentar uma nova
# tentativa de subir, ou depois do worker já ter saído sozinho). Trata só
# do protocolo de ack/heartbeat do PEDIDO de parada - a máquina de estados
# do PROCESSO (Estado=Stopped) é responsabilidade separada de quem chama
# (ver watchdog-sync-financeiro.ps1: já está Stopped nesses pontos, porque
# Invoke-SyncFinanceiroWatchdogInicio só libera DeveIniciarWorker=$true a
# partir de um estado seguro, e a própria geração grava Stopped assim que
# confirma a morte do worker que ELA rastreava).
# CORRECAO FASE 2E (7a rodada): heartbeat gravado ANTES do ACK - o ACK e
# sempre o ULTIMO artefato de protocolo escrito, nunca o primeiro. Nenhuma
# operacao falivel de protocolo roda depois de Write-SyncFinanceiroAck
# aqui (a funcao termina logo em seguida, so monta o objeto de retorno).
function Confirm-SyncFinanceiroParadaAposSaidaNatural {
  param([Parameter(Mandatory)][string]$Raiz)
  $token = Get-SyncFinanceiroRequestIdDeParada -Raiz $Raiz
  Write-SyncFinanceiroHeartbeat -Raiz $Raiz -Estado 'Parado' -WorkerPid $null
  if ($token) { Write-SyncFinanceiroAck -Raiz $Raiz -RequestId $token -Tipo 'Parar' -Estado 'Parado' -WorkerPid $null }
  [pscustomobject]@{ RequestIdConfirmado = $token }
}

# Usado quando o watchdog encontra o sinalizador DURANTE a execução, com
# um worker vivo sob seu próprio handle: chama -PararProcesso (o
# Stop-Process real, injetável), e só considera Confirmado depois de
# confirmar via -ProcessoSaiu (baseado no HANDLE PRÓPRIO do watchdog —
# nunca WMI) que o processo realmente terminou.
#
# CORRECAO FASE 2E (6ª rodada) — substituiu
# Invoke-SyncFinanceiroWatchdogConfirmarParada: o ACK agora é tratado como
# o ÚLTIMO registro de "commit" da parada, NUNCA o primeiro. Ordem
# obrigatória: (1) confirma a morte do Node; (2) drena a saída; (3)
# persiste Estado=Stopped na máquina de estados (dono = GeracaoId do
# chamador) e VERIFICA o resultado; (4) SÓ SE (3) teve sucesso, publica o
# ACK Parado com o RequestId exato, por último. Se a gravação de Stopped
# falhar, o ACK NUNCA é publicado — o sinalizador de parada permanece
# (nada aqui o remove) e o erro real de persistência é reportado
# explicitamente, nunca escondido atrás de um "Confirmado=true" genérico.
function Invoke-SyncFinanceiroWatchdogPararEConfirmar {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$GeracaoId,
    [string]$RequestId,
    $WorkerPid,
    [Parameter(Mandatory)][scriptblock]$PararProcesso,
    [Parameter(Mandatory)][scriptblock]$ProcessoSaiu,
    [scriptblock]$DrenarSaida = { },
    [int]$TimeoutSegundos = 30,
    [int]$IntervaloSegundos = 1,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  try { & $PararProcesso } catch {
    # Pode falhar porque o processo já morreu sozinho entre a checagem do
    # sinalizador e aqui — sem problema, o polling de ProcessoSaiu abaixo
    # ainda confirma o estado real.
  }
  $saiu = Wait-SyncFinanceiroCondicao -Condicao { & $ProcessoSaiu } `
    -TimeoutSegundos $TimeoutSegundos -IntervaloSegundos $IntervaloSegundos -Dormir $Dormir

  if (-not $saiu) {
    return [pscustomobject]@{ Confirmado = $false; EstadoPersistido = $false; AckPublicado = $false; Erro = 'processo nao confirmou encerramento dentro do prazo apos a tentativa de parar' }
  }

  try { & $DrenarSaida } catch {}

  $rEstado = Set-SyncFinanceiroEstadoWorker -Raiz $Raiz -Estado 'Stopped' -GeracaoId $GeracaoId -WorkerPid $WorkerPid
  if (-not $rEstado.Sucesso) {
    return [pscustomobject]@{
      Confirmado = $true; EstadoPersistido = $false; AckPublicado = $false
      Erro       = "worker confirmado morto, mas FALHA ao persistir Estado=Stopped ($($rEstado.Erro)) - ACK Parado NAO publicado, sinalizador de parada preservado"
    }
  }

  # CORRECAO FASE 2E (7a rodada): heartbeat ANTES do ACK - o ACK e sempre
  # o ULTIMO artefato de protocolo (nenhuma operacao falivel roda depois).
  Write-SyncFinanceiroHeartbeat -Raiz $Raiz -Estado 'Parado' -WorkerPid $null
  if ($RequestId) { Write-SyncFinanceiroAck -Raiz $Raiz -RequestId $RequestId -Tipo 'Parar' -Estado 'Parado' -WorkerPid $WorkerPid }
  [pscustomobject]@{ Confirmado = $true; EstadoPersistido = $true; AckPublicado = $true; Erro = $null }
}

# Usado logo depois de Start-Process (com Estado=Running já persistido pelo
# chamador): só considera Confirmado depois do worker permanecer vivo (via
# -AindaVivo, handle próprio) pelo período mínimo definido — nunca confirma
# "de pé" antes da hora.
#
# CORRECAO FASE 2E (6ª rodada): o ACK Rodando é o ÚLTIMO artefato gravado -
# heartbeat (e qualquer outro artefato falível) vem ANTES dele. O ACK com o
# RequestId exato é o "commit" final da partida: nenhuma operação capaz de
# causar rollback pode rodar depois dele. Se ALGO aqui lançar (ex.: o
# heartbeat falhar por I/O) a exceção propaga pro chamador
# (Invoke-SyncFinanceiroWatchdogPartidaTransacional via -PosRunning), que
# aciona o desfazimento completo (mata o Node, confirma, persiste Stopped/
# Unknown) - e, por construção, nenhum ACK Rodando pode existir nesse caso,
# porque ele só seria gravado DEPOIS do heartbeat que falhou.
function Invoke-SyncFinanceiroWatchdogConfirmarInicio {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$RequestId,
    [Parameter(Mandatory)]$WorkerPid,
    [Parameter(Mandatory)][scriptblock]$AindaVivo,
    [int]$MinUptimeSegundos = 5,
    [int]$IntervaloSegundos = 1,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  $decorridos = 0
  while ($decorridos -lt $MinUptimeSegundos) {
    if (-not (& $AindaVivo)) { return [pscustomobject]@{ Confirmado = $false } }
    & $Dormir $IntervaloSegundos
    $decorridos += $IntervaloSegundos
  }
  if (-not (& $AindaVivo)) { return [pscustomobject]@{ Confirmado = $false } }

  Write-SyncFinanceiroHeartbeat -Raiz $Raiz -Estado 'Rodando' -WorkerPid $WorkerPid
  Write-SyncFinanceiroAck -Raiz $Raiz -RequestId $RequestId -Tipo 'Ligar' -Estado 'Rodando' -WorkerPid $WorkerPid
  [pscustomobject]@{ Confirmado = $true }
}

# Chamado a cada volta do loop de monitoramento (worker já confirmado e
# vivo): sempre atualiza o heartbeat, e se houver um pedido de Ligar mais
# novo que o ack atual (caso idempotente — Ligar chamado enquanto o
# worker já está de pé), re-carimba o ack Rodando com o RequestId desse
# pedido, sem reiniciar nada.
function Update-SyncFinanceiroWatchdogEmExecucao {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)]$WorkerPid,
    [Parameter(Mandatory)][scriptblock]$AindaVivo
  )
  Write-SyncFinanceiroHeartbeat -Raiz $Raiz -Estado 'Rodando' -WorkerPid $WorkerPid
  if (-not (& $AindaVivo)) { return [pscustomobject]@{ AckAtualizado = $false } }

  $reqAtual = Get-SyncFinanceiroRequestAtual -Raiz $Raiz
  if ($reqAtual -and $reqAtual.Tipo -eq 'Ligar') {
    $ackAtual = Get-SyncFinanceiroAckAtual -Raiz $Raiz
    if (-not $ackAtual -or $ackAtual.RequestId -ne $reqAtual.RequestId) {
      Write-SyncFinanceiroAck -Raiz $Raiz -RequestId $reqAtual.RequestId -Tipo 'Ligar' -Estado 'Rodando' -WorkerPid $WorkerPid
      return [pscustomobject]@{ AckAtualizado = $true }
    }
  }
  [pscustomobject]@{ AckAtualizado = $false }
}

# ═══════════════════════════════════════════════════════════════════════
# ── MÁQUINA DE ESTADOS DO WORKER (Fase 2E, 5ª rodada) ───────────────────
# ═══════════════════════════════════════════════════════════════════════

$script:EstadosValidos = @('Starting', 'Running', 'Stopping', 'Stopped', 'Unknown')

# Leitura da máquina de estados — NUNCA devolve $null: ausência do arquivo,
# corrupção, Estado desconhecido, ou Running sem Pid/StartTimeUtc/GeracaoId
# viram, TODOS, um objeto sintético com Estado='Unknown' e MotivoIncerto
# explicando o porquê. Isso garante que quem chama nunca precisa (e nunca
# pode) tratar "não consegui ler" como "está tudo bem, pode iniciar".
function Get-SyncFinanceiroEstadoWorkerAtual {
  param([Parameter(Mandatory)][string]$Raiz)
  $caminho = Get-SyncFinanceiroEstadoPath -Raiz $Raiz
  $vazio = {
    param($motivo, $obj)
    [pscustomobject]@{
      Estado          = 'Unknown'; MotivoIncerto = $motivo; ProtocolVersion = $(if ($obj) { $obj.ProtocolVersion } else { $null })
      GeracaoId       = $(if ($obj) { $obj.GeracaoId } else { $null }); Pid = $(if ($obj) { $obj.Pid } else { $null })
      StartTimeUtc    = $(if ($obj) { $obj.StartTimeUtc } else { $null }); AtualizadoEm = $(if ($obj) { $obj.AtualizadoEm } else { $null })
    }
  }
  if (-not (Test-Path -LiteralPath $caminho)) {
    return & $vazio 'arquivo de estado ausente (protocolo nunca inicializado, ou arquivo sumiu depois de inicializado - de qualquer forma, nunca autoriza start automatico)' $null
  }
  $obj = Read-SyncFinanceiroJsonArquivo -Caminho $caminho
  if (-not $obj -or -not $obj.Estado) {
    return & $vazio 'arquivo de estado presente mas corrompido/ilegivel' $obj
  }
  # CORRECAO FASE 2E (6a rodada): so ProtocolVersion=1 pode ser interpretado.
  # Campo ausente, zero, ou qualquer versao diferente (inclusive futura,
  # que este codigo nao sabe como interpretar) tem que virar Unknown e
  # bloquear start - nunca assumir compatibilidade por omissao.
  $versaoValida = $false
  try { $versaoValida = ($null -ne $obj.ProtocolVersion) -and ([int]$obj.ProtocolVersion -eq 1) } catch { $versaoValida = $false }
  if (-not $versaoValida) {
    return & $vazio "ProtocolVersion invalido/ausente no arquivo: '$($obj.ProtocolVersion)' (so a versao 1 e suportada por este codigo)" $obj
  }
  if ($obj.Estado -notin $script:EstadosValidos) {
    return & $vazio "valor de Estado invalido no arquivo: '$($obj.Estado)'" $obj
  }
  if ($obj.Estado -eq 'Running' -and (-not $obj.Pid -or -not $obj.StartTimeUtc -or -not $obj.GeracaoId)) {
    return & $vazio 'Estado=Running sem Pid/StartTimeUtc/GeracaoId obrigatorios' $obj
  }
  if (-not ($obj | Get-Member -Name MotivoIncerto -ErrorAction SilentlyContinue)) {
    $obj | Add-Member -NotePropertyName MotivoIncerto -NotePropertyValue $null
  }
  $obj
}

# Escrita CRUA da máquina de estados - NÃO exportada, NÃO adquire o lock
# sozinha (pressupõe que o CHAMADOR já está dentro de
# Invoke-SyncFinanceiroComLockEstado), e NÃO checa dono atual. É o único
# lugar que realmente grava bytes no arquivo de estado - toda escrita
# "protegida" ou "bruta" do resto do módulo passa por aqui.
function Write-SyncFinanceiroEstadoWorkerInterno {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$Estado,
    [Parameter(Mandatory)][string]$GeracaoId,
    $WorkerPid,
    [object]$StartTimeUtc
  )
  $startTimeUtcTexto = if ($null -ne $StartTimeUtc) { ([datetime]$StartTimeUtc).ToUniversalTime().ToString('o') } else { $null }
  Write-SyncFinanceiroJsonArquivo -Caminho (Get-SyncFinanceiroEstadoPath -Raiz $Raiz) -Objeto ([pscustomobject]@{
    ProtocolVersion = 1
    Estado          = $Estado
    GeracaoId       = $GeracaoId
    Pid             = $WorkerPid
    StartTimeUtc    = $startTimeUtcTexto
    AtualizadoEm    = (Get-Date).ToUniversalTime().ToString('o')
  })
}

# Escrita PROTEGIDA (caminho normal) - sob o MESMO lock: releia o estado
# atual, valide que ele pertence à mesma GeracaoId (ou não tem dono ainda),
# e só então grave. Isso é o que impede uma geração antiga/zumbi de
# sobrescrever o estado de uma geração mais nova que já assumiu o controle
# - inclusive durante desfazimento (Fase 2E, 6ª rodada: NENHUM caminho
# normal usa mais um bypass genérico tipo "-Inicial" - a única exceção é a
# reivindicação inicial de Starting, que é uma OPERAÇÃO DEDICADA e também
# protegida por lock, ver Invoke-SyncFinanceiroWatchdogInicio) e o
# bootstrap explícito (Initialize-SyncFinanceiroEstadoWorker, também sua
# própria operação dedicada). NUNCA usa -ErrorAction SilentlyContinue.
function Set-SyncFinanceiroEstadoWorker {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][ValidateSet('Starting', 'Running', 'Stopping', 'Stopped', 'Unknown')][string]$Estado,
    [Parameter(Mandatory)][string]$GeracaoId,
    $WorkerPid,
    # NUNCA tipar como [Nullable[datetime]] aqui - achado real de rodada
    # anterior: PowerShell 5.1 desembrulha/reembrulha Nullable[datetime] de
    # forma inconsistente ao vir de um parametro (.HasValue vem vazio,
    # .Value falha com "nao e possivel chamar um metodo em uma expressao de
    # valor nulo" mesmo com um DateTime real atribuido). [object] + checagem
    # explicita de $null e o cast [datetime] só quando presente evita isso.
    [object]$StartTimeUtc,
    [int]$TimeoutLockSegundos = 30
  )
  try {
    Invoke-SyncFinanceiroComLockEstado -Raiz $Raiz -TimeoutSegundos $TimeoutLockSegundos -Corpo {
      $atual = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $Raiz
      if ($atual.GeracaoId -and $atual.GeracaoId -ne $GeracaoId) {
        return [pscustomobject]@{ Sucesso = $false; Erro = "estado pertence a outra geracao (GeracaoId atual='$($atual.GeracaoId)', tentativa='$GeracaoId') - escrita recusada" }
      }
      try {
        Write-SyncFinanceiroEstadoWorkerInterno -Raiz $Raiz -Estado $Estado -GeracaoId $GeracaoId -WorkerPid $WorkerPid -StartTimeUtc $StartTimeUtc
        [pscustomobject]@{ Sucesso = $true; Erro = $null }
      } catch {
        [pscustomobject]@{ Sucesso = $false; Erro = $_.Exception.Message }
      }
    }
  } catch {
    [pscustomobject]@{ Sucesso = $false; Erro = "falha ao adquirir lock de estado: $($_.Exception.Message)" }
  }
}

# CORRECAO FASE 2E (7a rodada): a antiga "escrita BRUTA" (Set-SyncFinanceiroEstadoWorkerBruto,
# sem checagem de dono) foi ELIMINADA do módulo - revisão apontou que
# mesmo protegida pelo lock, ela era um bypass público de ownership
# alcançável por qualquer chamador (inclusive scripts de produção), não só
# pelos testes. A ÚNICA escrita sem checagem de dono que sobrevive é
# Write-SyncFinanceiroEstadoWorkerInterno (não exportada, não adquire
# lock sozinha) - usada só (a) dentro da seção crítica dedicada de
# Invoke-SyncFinanceiroWatchdogInicio, que já validou sob o MESMO lock que
# a reivindicação é segura, e (b) pelo bootstrap explícito único
# (Initialize-SyncFinanceiroEstadoWorker), que já validou sob o MESMO lock
# que nenhum arquivo de estado existe ainda. Testes que precisam de um
# estado arbitrário como fixture agora escrevem o JSON diretamente no
# arquivo (ver Set-SyncFinanceiroEstadoFixture em
# sync-financeiro-control.tests.ps1) - sem passar pelo módulo, exatamente
# como qualquer corrupção/edição externa real do arquivo apareceria.

# ── Bootstrap explícito (única forma de inicializar o protocolo) ────────
# NUNCA chamado automaticamente pelo watchdog. Só deve ser executado
# manualmente, uma vez, durante o release controlado - ver o procedimento
# completo no comentário grande do topo deste arquivo. Recusa rodar sem a
# confirmação explícita, e recusa rodar de novo se um arquivo de estado
# JÁ EXISTIR (mesmo Unknown/corrompido) - bootstrap nunca é um "reset"
# automático, só a primeira inicialização. A checagem de existência e a
# escrita acontecem sob o MESMO lock (Fase 2E, 6ª rodada) - sem isso, dois
# bootstraps concorrentes poderiam ambos ver "arquivo ausente" e ambos
# escrever.
function Initialize-SyncFinanceiroEstadoWorker {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [switch]$ConfirmeiQueNenhumWorkerAntigoEstaRodando,
    [int]$TimeoutLockSegundos = 30
  )
  if (-not $ConfirmeiQueNenhumWorkerAntigoEstaRodando) {
    return [pscustomobject]@{ Sucesso = $false; Erro = 'bootstrap recusado: precisa confirmar explicitamente (-ConfirmeiQueNenhumWorkerAntigoEstaRodando) que nenhum worker antigo esta rodando - ver procedimento no topo do modulo' }
  }
  try {
    Invoke-SyncFinanceiroComLockEstado -Raiz $Raiz -TimeoutSegundos $TimeoutLockSegundos -Corpo {
      $caminho = Get-SyncFinanceiroEstadoPath -Raiz $Raiz
      if (Test-Path -LiteralPath $caminho) {
        return [pscustomobject]@{ Sucesso = $false; Erro = 'bootstrap recusado: ja existe um arquivo de estado - bootstrap so roda uma vez, sobre nenhum estado previo (corrupcao acidental depois do bootstrap exige intervencao manual deliberada, nao um re-run deste script)' }
      }
      $geracaoIdBootstrap = [guid]::NewGuid().ToString()
      try {
        Write-SyncFinanceiroEstadoWorkerInterno -Raiz $Raiz -Estado 'Stopped' -GeracaoId $geracaoIdBootstrap -WorkerPid $null -StartTimeUtc $null
        [pscustomobject]@{ Sucesso = $true; Erro = $null; GeracaoId = $geracaoIdBootstrap }
      } catch {
        [pscustomobject]@{ Sucesso = $false; Erro = $_.Exception.Message }
      }
    }
  } catch {
    [pscustomobject]@{ Sucesso = $false; Erro = "falha ao adquirir lock de estado: $($_.Exception.Message)" }
  }
}

# Ponto de entrada de cada geração do supervisor. Lê a máquina de estados
# e decide DeveIniciarWorker baseado EXCLUSIVAMENTE nela:
#   - Unknown/Starting/Stopping: sempre bloqueia (EstadoIncerto=$true),
#     nunca inicia, nunca escreve ack/heartbeat de "Parado".
#   - Running: só desbloqueia se Invoke-SyncFinanceiroReconciliarWorkerAnterior
#     confirmar (via PID+StartTimeUtc EXATOS, nunca WMI) que o processo
#     registrado não existe mais (ou não é o mesmo processo).
#   - Stopped: desbloqueia direto, sem tocar em WMI/processo nenhum.
# Independente do sinalizador de parada - a pré-condição "estado confirma
# ausência de worker anterior" é UNIVERSAL (ver Fase 2E, 4ª rodada).
#
# CORRECAO FASE 2E (6ª rodada): a DECISÃO "seguro iniciar" e a
# REIVINDICAÇÃO de Starting agora formam uma ÚNICA operação atômica sob o
# mesmo lock cross-process (Invoke-SyncFinanceiroComLockEstado) - não pode
# mais existir um intervalo entre "li Stopped, decidi que é seguro" e
# "gravei Starting" onde outra geração também leia Stopped e também decida
# reivindicar. É por isso que -GeracaoId agora é obrigatório aqui: se
# DeveIniciarWorker vier $true, Starting JÁ FOI reivindicado no disco para
# esse GeracaoId exato antes desta função retornar (ver Reivindicado=$true
# no resultado) - quem chama NUNCA reivindica de novo.
function Invoke-SyncFinanceiroWatchdogInicio {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$GeracaoId,
    [scriptblock]$ObterProcessoPorId = $script:ObterProcessoPorIdPadrao,
    [scriptblock]$EncerrarProcesso = $script:EncerrarProcessoPadrao,
    [int]$TimeoutReconfirmacaoSegundos = 10,
    [int]$IntervaloReconfirmacaoSegundos = 1,
    [scriptblock]$Dormir = $script:DormirPadrao,
    [int]$TimeoutLockSegundos = 30
  )
  try {
    Invoke-SyncFinanceiroComLockEstado -Raiz $Raiz -TimeoutSegundos $TimeoutLockSegundos -Corpo {
      $estadoAtual = Get-SyncFinanceiroEstadoWorkerAtual -Raiz $Raiz

      $bloqueado = $false
      $motivoBloqueio = $null
      # CORRECAO FASE 2E (7a rodada): marca quando um Estado=Running foi
      # reconciliado POSITIVAMENTE nesta mesma chamada (processo anterior
      # confirmado morto, ou PID reaproveitado) - usado logo abaixo pra
      # persistir Estado=Stopped (ainda sob o MESMO lock) antes de
      # publicar qualquer heartbeat/ACK de "Parado", quando o sinalizador
      # estiver presente.
      $reconciliouRunning = $false
      switch ($estadoAtual.Estado) {
        'Unknown' { $bloqueado = $true; $motivoBloqueio = "estado Unknown: $($estadoAtual.MotivoIncerto)" }
        'Starting' { $bloqueado = $true; $motivoBloqueio = "estado Starting (GeracaoId=$($estadoAtual.GeracaoId)) de uma geracao anterior nao resolvido - nunca autoriza start automatico" }
        'Stopping' { $bloqueado = $true; $motivoBloqueio = "estado Stopping (GeracaoId=$($estadoAtual.GeracaoId)) de uma geracao anterior nao resolvido - nunca autoriza start automatico" }
        'Running' {
          $resultadoReconciliacao = Invoke-SyncFinanceiroReconciliarWorkerAnterior -Raiz $Raiz -EstadoAtual $estadoAtual `
            -ObterProcessoPorId $ObterProcessoPorId -EncerrarProcesso $EncerrarProcesso `
            -TimeoutReconfirmacaoSegundos $TimeoutReconfirmacaoSegundos -IntervaloReconfirmacaoSegundos $IntervaloReconfirmacaoSegundos -Dormir $Dormir
          if (-not $resultadoReconciliacao.Sucesso) { $bloqueado = $true; $motivoBloqueio = $resultadoReconciliacao.Erro }
          else { $reconciliouRunning = $true }
        }
        'Stopped' { }
      }

      if ($bloqueado) {
        return [pscustomobject]@{
          DeveIniciarWorker = $false; EstadoIncerto = $true; Reivindicado = $false
          MotivoBloqueio    = $motivoBloqueio; EstadoAnterior = $estadoAtual.Estado; RequestIdConfirmado = $null
        }
      }

      if (-not (Test-SyncFinanceiroFlagPresente -Raiz $Raiz)) {
        # ── SEÇÃO CRÍTICA: reivindicação de Starting, AINDA sob o mesmo
        # lock que leu $estadoAtual acima - nenhuma outra geração pode ter
        # visto "seguro" e reivindicado entre a leitura e esta escrita.
        try {
          Write-SyncFinanceiroEstadoWorkerInterno -Raiz $Raiz -Estado 'Starting' -GeracaoId $GeracaoId -WorkerPid $null -StartTimeUtc $null
        } catch {
          return [pscustomobject]@{
            DeveIniciarWorker = $false; EstadoIncerto = $true; Reivindicado = $false
            MotivoBloqueio    = "falha ao reivindicar Starting sob o lock: $($_.Exception.Message)"; EstadoAnterior = $estadoAtual.Estado; RequestIdConfirmado = $null
          }
        }
        return [pscustomobject]@{
          DeveIniciarWorker = $true; EstadoIncerto = $false; Reivindicado = $true
          MotivoBloqueio    = $null; EstadoAnterior = $estadoAtual.Estado; RequestIdConfirmado = $null
        }
      }

      # SINALIZADOR PRESENTE. CORRECAO FASE 2E (7a rodada): se o estado
      # anterior era Running e foi reconciliado POSITIVAMENTE (worker
      # confirmado morto ou PID reaproveitado, ver acima), a maquina de
      # estados PRECISA refletir isso antes de qualquer heartbeat/ACK -
      # persiste Estado=Stopped, ainda sob o MESMO lock (nunca reabre uma
      # secao critica nova - usa a escrita CRUA porque o dono anterior
      # [a geracao morta] nao e mais quem esta escrevendo; esta geracao,
      # que acabou de PROVAR que o worker anterior morreu, e quem fecha o
      # registro). Se a persistencia falhar, NUNCA publica heartbeat/ACK
      # de sucesso - devolve EstadoIncerto=true com o erro real, exatamente
      # como qualquer outra falha de persistencia neste modulo.
      if ($reconciliouRunning) {
        try {
          Write-SyncFinanceiroEstadoWorkerInterno -Raiz $Raiz -Estado 'Stopped' -GeracaoId $GeracaoId -WorkerPid $null -StartTimeUtc $null
        } catch {
          return [pscustomobject]@{
            DeveIniciarWorker = $false; EstadoIncerto = $true; Reivindicado = $false
            MotivoBloqueio    = "worker anterior confirmado morto (reconciliado), mas FALHA ao persistir Estado=Stopped sob o lock - nenhum heartbeat/ACK publicado: $($_.Exception.Message)"
            EstadoAnterior    = $estadoAtual.Estado; RequestIdConfirmado = $null
          }
        }
      }

      # CORRECAO FASE 2E (7a rodada): heartbeat ANTES do ACK - o ACK e
      # sempre o ULTIMO artefato de protocolo (nenhuma operacao falivel
      # roda depois dele, nem aqui nem em lugar nenhum do caminho abaixo).
      $token = Get-SyncFinanceiroRequestIdDeParada -Raiz $Raiz
      Write-SyncFinanceiroHeartbeat -Raiz $Raiz -Estado 'Parado' -WorkerPid $null
      if ($token) { Write-SyncFinanceiroAck -Raiz $Raiz -RequestId $token -Tipo 'Parar' -Estado 'Parado' -WorkerPid $null }
      [pscustomobject]@{
        DeveIniciarWorker = $false; EstadoIncerto = $false; Reivindicado = $false
        MotivoBloqueio    = $null; EstadoAnterior = $estadoAtual.Estado; RequestIdConfirmado = $token
      }
    }
  } catch {
    [pscustomobject]@{
      DeveIniciarWorker = $false; EstadoIncerto = $true; Reivindicado = $false
      MotivoBloqueio    = "falha na secao critica do lock de estado: $($_.Exception.Message)"; EstadoAnterior = $null; RequestIdConfirmado = $null
    }
  }
}

# Wrapper de retentativa/backoff em torno de Invoke-SyncFinanceiroWatchdogInicio
# — dá algumas chances (padrão: 3, 5s entre elas) pra um problema
# TRANSIENTE na reconciliação (ex.: uma consulta de processo que falhou
# uma vez) se resolver sozinho, antes do watchdog desistir desta geração.
# Nunca inicia worker nenhum enquanto estiver incerto; se esgotar as
# tentativas, devolve o último resultado (ainda EstadoIncerto=$true) pro
# chamador decidir o que fazer (watchdog-sync-financeiro.ps1: loga e sai
# pro próximo disparo natural do Scheduler, nunca inicia nada por cima da
# incerteza).
function Invoke-SyncFinanceiroWatchdogInicioComRetentativas {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$GeracaoId,
    [scriptblock]$ObterProcessoPorId = $script:ObterProcessoPorIdPadrao,
    [scriptblock]$EncerrarProcesso = $script:EncerrarProcessoPadrao,
    [int]$MaxTentativas = 3,
    [int]$IntervaloSegundos = 5,
    [int]$TimeoutReconfirmacaoSegundos = 10,
    [int]$IntervaloReconfirmacaoSegundos = 1,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  $decisao = $null
  for ($tentativa = 1; $tentativa -le $MaxTentativas; $tentativa++) {
    $decisao = Invoke-SyncFinanceiroWatchdogInicio -Raiz $Raiz -GeracaoId $GeracaoId -ObterProcessoPorId $ObterProcessoPorId -EncerrarProcesso $EncerrarProcesso `
      -TimeoutReconfirmacaoSegundos $TimeoutReconfirmacaoSegundos -IntervaloReconfirmacaoSegundos $IntervaloReconfirmacaoSegundos -Dormir $Dormir
    if (-not $decisao.EstadoIncerto) { return $decisao }
    if ($tentativa -lt $MaxTentativas) { & $Dormir $IntervaloSegundos }
  }
  $decisao
}

# Reconciliação de um Estado=Running anterior via IDENTIDADE EXATA
# (PID+StartTimeUtc, comparação por TICKS em UTC, sem tolerância - um PID
# reaproveitado rapidamente tem, por definição, um StartTime diferente do
# original, e ticks exatos nunca colidem por arredondamento). NUNCA usa
# WMI/CommandLine pra decidir isso - só a função de diagnóstico legada
# (Invoke-SyncFinanceiroLimpezaLegadoWmi) faz isso, e ela não é chamada
# daqui.
#   - PID não existe mais, OU existe com StartTimeUtc DIFERENTE (=outro
#     processo, PID reaproveitado): worker registrado confirmado morto -
#     Sucesso=$true/ProcessosRestantes=0 (NÃO escreve Estado aqui - quem
#     chama, ao decidir iniciar um worker novo, reivindica Starting com
#     -Inicial, que sobrescreve este registro obsoleto).
#   - PID existe com o MESMO StartTimeUtc exato: realmente ainda vivo -
#     tenta encerrar e RECONFIRMA pela mesma identidade (ticks exatos)
#     antes de considerar zero.
#   - Qualquer falha ao consultar/encerrar/reconfirmar: Sucesso=$false,
#     ProcessosRestantes=-1 (nunca confirma zero por omissão).
function Invoke-SyncFinanceiroReconciliarWorkerAnterior {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)]$EstadoAtual,
    [scriptblock]$ObterProcessoPorId = $script:ObterProcessoPorIdPadrao,
    [scriptblock]$EncerrarProcesso = $script:EncerrarProcessoPadrao,
    [int]$TimeoutReconfirmacaoSegundos = 10,
    [int]$IntervaloReconfirmacaoSegundos = 1,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  try {
    $tsRegistradoUtc = ([datetime]$EstadoAtual.StartTimeUtc).ToUniversalTime()
  } catch {
    return [pscustomobject]@{ Sucesso = $false; ProcessosRestantes = -1; Erro = "StartTimeUtc registrado ilegivel: $($_.Exception.Message)" }
  }

  try {
    $procAtual = & $ObterProcessoPorId $EstadoAtual.Pid
  } catch {
    return [pscustomobject]@{ Sucesso = $false; ProcessosRestantes = -1; Erro = "falha ao consultar processo PID $($EstadoAtual.Pid): $($_.Exception.Message)" }
  }

  $mesmoProcesso = $false
  if ($procAtual) {
    try {
      $tsAtualUtc = ([datetime]$procAtual.StartTime).ToUniversalTime()
      $mesmoProcesso = ($tsAtualUtc.Ticks -eq $tsRegistradoUtc.Ticks)
    } catch {
      return [pscustomobject]@{ Sucesso = $false; ProcessosRestantes = -1; Erro = "falha ao comparar StartTime do PID $($EstadoAtual.Pid): $($_.Exception.Message)" }
    }
  }

  if (-not $mesmoProcesso) {
    return [pscustomobject]@{ Sucesso = $true; ProcessosRestantes = 0; Erro = $null }
  }

  # Mesmo processo, mesmos ticks exatos - realmente ainda vivo. Tenta
  # encerrar e RECONFIRMA pela mesma identidade (nao so "sumiu algum PID").
  # A reconfirmacao faz POLLING (nunca uma unica checagem imediata) -
  # achado real desta rodada: Stop-Process pode retornar antes do SO
  # terminar de remover o processo da tabela que Get-Process consulta,
  # entao checar so 1x logo em seguida podia dar falso "ainda vivo".
  try { & $EncerrarProcesso $EstadoAtual.Pid } catch {
    return [pscustomobject]@{ Sucesso = $false; ProcessosRestantes = 1; Erro = "falha ao encerrar worker identificado (PID $($EstadoAtual.Pid)): $($_.Exception.Message)" }
  }

  $erroReconfirmacao = $null
  $confirmadoMorto = Wait-SyncFinanceiroCondicao -Condicao {
    try {
      $procDepois = & $ObterProcessoPorId $EstadoAtual.Pid
    } catch {
      $erroReconfirmacao = "falha ao reconfirmar encerramento do PID $($EstadoAtual.Pid): $($_.Exception.Message)"
      return $true # para de tentar - a checagem de $erroReconfirmacao abaixo decide o resultado
    }
    if (-not $procDepois) { return $true }
    try {
      $tsDepoisUtc = ([datetime]$procDepois.StartTime).ToUniversalTime()
      return ($tsDepoisUtc.Ticks -ne $tsRegistradoUtc.Ticks) # e outro processo (PID ja reaproveitado) = confirmado morto
    } catch {
      return $false # incerteza -> trata como ainda vivo, fail-safe, continua tentando
    }
  } -TimeoutSegundos $TimeoutReconfirmacaoSegundos -IntervaloSegundos $IntervaloReconfirmacaoSegundos -Dormir $Dormir

  if ($erroReconfirmacao) {
    return [pscustomobject]@{ Sucesso = $false; ProcessosRestantes = -1; Erro = $erroReconfirmacao }
  }
  if (-not $confirmadoMorto) {
    return [pscustomobject]@{ Sucesso = $false; ProcessosRestantes = 1; Erro = "worker identificado (PID $($EstadoAtual.Pid)) nao confirmou encerramento dentro do prazo" }
  }
  [pscustomobject]@{ Sucesso = $true; ProcessosRestantes = 0; Erro = $null }
}

# ── Gerenciamento do processo do worker (Fase 2E, 4ª/5ª rodada) ────────
# Extraído de watchdog-sync-financeiro.ps1 pra cá pra ficar IMPORTÁVEL e
# TESTÁVEL isoladamente (com um processo descartável real, nunca o worker
# de verdade) sem executar o loop infinito do watchdog. FileName/
# Argumentos/WorkingDirectory são sempre injetados pelo chamador — em
# produção, watchdog-sync-financeiro.ps1 passa node.exe + o script real;
# nos testes, um processo descartável qualquer (ex.: powershell.exe).
#
# CORRECAO FASE 2E (5ª rodada): as DUAS assinaturas de evento agora vivem
# DENTRO do mesmo try que faz .Start() - achado da revisão: se a SEGUNDA
# assinatura (stderr) falhasse, a PRIMEIRA (stdout) e o writer ficavam sem
# liberar (o try antigo só envolvia .Start()/BeginRead, não o
# Register-ObjectEvent em si).
function Start-SyncFinanceiroWorkerProcesso {
  param(
    [Parameter(Mandatory)][string]$FileName,
    [Parameter(Mandatory)][string]$Argumentos,
    [Parameter(Mandatory)][string]$WorkingDirectory,
    [Parameter(Mandatory)][string]$LogPath
  )
  $writer = $null
  $assinaturaSaida = $null
  $assinaturaErro = $null
  $proc = $null
  try {
    $writer = [System.IO.StreamWriter]::new($LogPath, $true)
    $writer.AutoFlush = $true

    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $FileName
    $psi.Arguments = $Argumentos
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = [System.Diagnostics.Process]::new()
    $proc.StartInfo = $psi
    $proc.EnableRaisingEvents = $true

    $acaoSaida = {
      if ($null -ne $EventArgs.Data) { try { $Event.MessageData.WriteLine($EventArgs.Data) } catch {} }
    }
    $assinaturaSaida = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $writer -Action $acaoSaida
    $assinaturaErro = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -MessageData $writer -Action $acaoSaida

    $proc.Start() | Out-Null
    $proc.BeginOutputReadLine()
    $proc.BeginErrorReadLine()
  } catch {
    # CORRECAO FASE 2E (6ª rodada): -Job (referência direta do objeto
    # PSEventJob devolvido por Register-ObjectEvent), NUNCA -Name - -Name
    # força o Remove-Job a resolver por busca no repositório GLOBAL de
    # jobs (todos os adaptadores, inclusive PSScheduledJob), que em
    # ambientes com permissão restrita pode falhar/gerar aviso mesmo
    # quando o job em si é só um PSEventJob local deste processo.
    if ($assinaturaErro) {
      try { Unregister-Event -SourceIdentifier $assinaturaErro.Name -ErrorAction Stop } catch {}
      try { Remove-Job -Job $assinaturaErro -Force -ErrorAction Stop } catch {}
    }
    if ($assinaturaSaida) {
      try { Unregister-Event -SourceIdentifier $assinaturaSaida.Name -ErrorAction Stop } catch {}
      try { Remove-Job -Job $assinaturaSaida -Force -ErrorAction Stop } catch {}
    }
    if ($writer) { try { $writer.Dispose() } catch {} }
    if ($proc) { try { $proc.Dispose() } catch {} }
    throw
  }

  [pscustomobject]@{ Processo = $proc; Writer = $writer; AssinaturaSaida = $assinaturaSaida; AssinaturaErro = $assinaturaErro }
}

# Bloqueia até o processo sair E os leitores assíncronos de stdout/stderr
# terminarem de drenar (a chamada SEM parâmetro de Process.WaitForExit()
# é a forma documentada pela própria .NET de garantir isso - só checar
# $proc.HasExited via polling pode observar "true" um instante ANTES do
# último bloco de saída assíncrona terminar de chegar, perdendo linhas
# finais).
function Wait-SyncFinanceiroSaidaDrenada {
  param([Parameter(Mandatory)]$Processo)
  try { $Processo.WaitForExit() } catch {}
}

# Libera TUDO que Start-SyncFinanceiroWorkerProcesso alocou: as duas
# assinaturas de evento (Unregister-Event remove a assinatura, mas o
# PSEventJob associado só some de verdade com Remove-Job), o StreamWriter,
# e o objeto Process em si. Nunca decide/gate nenhuma confirmação - cada
# etapa é best-effort de propósito (mesmo motivo de Log() no watchdog:
# perder isso nunca pode derrubar o supervisor) - mas o resultado devolve
# um diagnóstico HONESTO de cada etapa (nunca finge sucesso), pra quem
# chama poder verificar sem precisar consultar Get-Job (que em ambientes
# restritos pode falhar por tentar enumerar o repositório GLOBAL de jobs,
# incluindo o adaptador PSScheduledJob - achado real desta rodada).
function Stop-SyncFinanceiroWorkerTracking {
  param($Handle)
  if (-not $Handle) {
    return [pscustomobject]@{
      AssinaturaSaidaRemovida = $true; JobSaidaRemovido = $true
      AssinaturaErroRemovida  = $true; JobErroRemovido = $true
      WriterDescartado        = $true; ProcessoDescartado = $true
    }
  }

  # CORRECAO FASE 2E (6ª rodada): Unregister-Event (a ASSINATURA) e
  # Remove-Job (o PSEventJob associado) são reportados SEPARADAMENTE - e
  # Remove-Job usa -Job (a referência direta devolvida por
  # Register-ObjectEvent), NUNCA -Name, porque -Name força uma busca no
  # repositório GLOBAL de jobs (todos os adaptadores, inclusive
  # PSScheduledJob em %LocalAppData%\...\ScheduledJobs) - achado real da
  # revisão: isso gerava avisos/acesso negado em ambientes restritos mesmo
  # quando o job em si é só um PSEventJob local deste processo.
  $assinaturaSaidaRemovida = $true
  $jobSaidaRemovido = $true
  if ($Handle.AssinaturaSaida) {
    try { Unregister-Event -SourceIdentifier $Handle.AssinaturaSaida.Name -ErrorAction Stop } catch { $assinaturaSaidaRemovida = $false }
    try { Remove-Job -Job $Handle.AssinaturaSaida -Force -ErrorAction Stop } catch { $jobSaidaRemovido = $false }
  }
  $assinaturaErroRemovida = $true
  $jobErroRemovido = $true
  if ($Handle.AssinaturaErro) {
    try { Unregister-Event -SourceIdentifier $Handle.AssinaturaErro.Name -ErrorAction Stop } catch { $assinaturaErroRemovida = $false }
    try { Remove-Job -Job $Handle.AssinaturaErro -Force -ErrorAction Stop } catch { $jobErroRemovido = $false }
  }
  $writerDescartado = $true
  try { $Handle.Writer.Flush() } catch {}
  try { $Handle.Writer.Dispose() } catch { $writerDescartado = $false }
  $processoDescartado = $true
  try { $Handle.Processo.Dispose() } catch { $processoDescartado = $false }

  [pscustomobject]@{
    AssinaturaSaidaRemovida = $assinaturaSaidaRemovida
    JobSaidaRemovido        = $jobSaidaRemovido
    AssinaturaErroRemovida  = $assinaturaErroRemovida
    JobErroRemovido         = $jobErroRemovido
    WriterDescartado        = $writerDescartado
    ProcessoDescartado      = $processoDescartado
  }
}

# ── Desfazimento de uma partida (Fase 2E, 5ª/6ª rodada) ─────────────────
# Usado sempre que um processo JÁ FOI CRIADO mas algo depois disso falhou
# (gravar Running, confirmar ACK/heartbeat, etc.) - ou quando o catch
# externo do watchdog encontra um handle de uma partida interrompida, ou
# quando o watchdog precisa tentar de novo reconciliar um handle que uma
# tentativa ANTERIOR já não conseguiu confirmar morto.
#
# CORRECAO FASE 2E (6ª rodada):
#   - Captura PID/StartTimeUtc do Handle ANTES de qualquer tentativa de
#     parar (nunca acessa propriedades do Process DEPOIS de descartado).
#   - Se a saída FOR confirmada: drena, persiste Stopped (verificando o
#     resultado), SÓ ENTÃO libera o tracking (Dispose) - devolve
#     Handle=$null (não há mais nada a rastrear).
#   - Se a saída NÃO for confirmada: NUNCA chama LiberarTracking/Dispose -
#     o handle é devolvido AINDA VIVO pro chamador (nunca perdido/
#     descartado em silêncio), e o estado gravado é Unknown (contendo
#     PID/StartTimeUtc/GeracaoId, pra preservar a identidade pra uma
#     futura reconciliação) em vez de Stopped - nunca finge confirmação
#     que não teve. Quem chama (o script do watchdog) é responsável por
#     manter uma estratégia explícita de novas tentativas sobre ESTE MESMO
#     handle/GeracaoId, e por NUNCA reiniciar outra geração ou outro
#     worker enquanto isso não resolver.
#   - Escrita de estado sempre pelo caminho PROTEGIDO (nunca um bypass tipo
#     "-Inicial") - esta função só é chamada pela própria geração dona do
#     registro (que reivindicou Starting atomicamente em
#     Invoke-SyncFinanceiroWatchdogInicio), então a escrita protegida
#     sempre é aceita, A MENOS que uma geração mais nova já tenha assumido
#     o controle nesse meio-tempo - nesse caso a escrita é corretamente
#     recusada, e isso é reportado via EstadoPersistido=$false.
function Invoke-SyncFinanceiroWatchdogDesfazerPartida {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$GeracaoId,
    [Parameter(Mandatory)]$Handle,
    [scriptblock]$PararProcesso = { param($H) Stop-Process -Id $H.Processo.Id -Force -ErrorAction Stop },
    [scriptblock]$ConfirmarSaida = { param($H) $H.Processo.Refresh(); $H.Processo.HasExited },
    [scriptblock]$DrenarSaida = { param($H) Wait-SyncFinanceiroSaidaDrenada -Processo $H.Processo },
    [scriptblock]$LiberarTracking = { param($H) Stop-SyncFinanceiroWorkerTracking -Handle $H | Out-Null },
    [int]$TimeoutSegundos = 30,
    [int]$IntervaloSegundos = 1,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  $pidCapturado = $null
  $startTimeUtcCapturado = $null
  try { $pidCapturado = $Handle.Processo.Id } catch {}
  try { $startTimeUtcCapturado = $Handle.Processo.StartTime.ToUniversalTime() } catch {}

  try { & $PararProcesso $Handle } catch {}
  $saiu = Wait-SyncFinanceiroCondicao -Condicao { & $ConfirmarSaida $Handle } `
    -TimeoutSegundos $TimeoutSegundos -IntervaloSegundos $IntervaloSegundos -Dormir $Dormir

  if ($saiu) {
    try { & $DrenarSaida $Handle } catch {}
    $rEstado = Set-SyncFinanceiroEstadoWorker -Raiz $Raiz -Estado 'Stopped' -GeracaoId $GeracaoId -WorkerPid $pidCapturado
    try { & $LiberarTracking $Handle } catch {}
    return [pscustomobject]@{
      Confirmado = $true; EstadoFinal = 'Stopped'; EstadoPersistido = $rEstado.Sucesso; ErroPersistencia = $rEstado.Erro
      Handle     = $null; PidRegistrado = $pidCapturado; StartTimeUtcRegistrado = $startTimeUtcCapturado
    }
  }

  # NÃO CONFIRMADO: o handle NUNCA é liberado/descartado aqui - ele volta
  # vivo pro chamador. O estado gravado é Unknown, preservando a
  # identidade (PID/StartTimeUtc/GeracaoId) pra uma tentativa futura.
  $rEstado = Set-SyncFinanceiroEstadoWorker -Raiz $Raiz -Estado 'Unknown' -GeracaoId $GeracaoId -WorkerPid $pidCapturado -StartTimeUtc $startTimeUtcCapturado
  [pscustomobject]@{
    Confirmado = $false; EstadoFinal = 'Unknown'; EstadoPersistido = $rEstado.Sucesso; ErroPersistencia = $rEstado.Erro
    Handle     = $Handle; PidRegistrado = $pidCapturado; StartTimeUtcRegistrado = $startTimeUtcCapturado
  }
}

# ── Partida transacional (Fase 2E, 5ª/6ª rodada) ────────────────────────
# PRÉ-CONDIÇÃO: Starting já foi reivindicado ATOMICAMENTE (junto com a
# decisão "seguro iniciar") por Invoke-SyncFinanceiroWatchdogInicio para
# este MESMO GeracaoId - esta função NÃO reivindica de novo (Fase 2E, 6ª
# rodada: decisão+reivindicação viram uma única seção crítica sob lock,
# sem intervalo entre elas onde outra geração pudesse também reivindicar -
# ver o comentário grande em Invoke-SyncFinanceiroWatchdogInicio).
# 1) Chama -IniciarProcesso (produz um Handle real ou lança).
# 2) Tenta gravar Running (Pid+StartTimeUtc+GeracaoId, escrita PROTEGIDA -
#    esta geração já é dona de Starting) e, se fornecido, roda -PosRunning
#    (ex.: confirmar ACK Ligar pendente - ver
#    Invoke-SyncFinanceiroWatchdogConfirmarInicio pra ordem heartbeat
#    antes do ACK).
# 3) QUALQUER falha no passo 2 (o processo JÁ EXISTE nesse ponto) aciona
#    Invoke-SyncFinanceiroWatchdogDesfazerPartida - se a morte for
#    confirmada, nunca deixa o filho vivo e nunca produz ACK "Rodando"
#    sobre a partida que falhou; se NÃO for confirmada, o Handle volta
#    vivo no resultado (Sucesso=$false, Handle preenchido) - o CHAMADOR
#    (watchdog-sync-financeiro.ps1) é responsável por manter esse handle e
#    tentar de novo, NUNCA iniciando outro worker/geração sobre a
#    incerteza.
# -PosRunning NÃO deve lançar pra uma morte NATURAL do processo durante a
# confirmação normal (isso é tratado pelo loop de monitoramento comum,
# fora desta função) - só deve lançar pra falhas operacionais genuínas
# (ex.: escrita de ack/heartbeat falhando).
function Invoke-SyncFinanceiroWatchdogPartidaTransacional {
  param(
    [Parameter(Mandatory)][string]$Raiz,
    [Parameter(Mandatory)][string]$GeracaoId,
    [Parameter(Mandatory)][scriptblock]$IniciarProcesso,
    [scriptblock]$PosRunning = { param($Handle) },
    [scriptblock]$PararProcesso = { param($H) Stop-Process -Id $H.Processo.Id -Force -ErrorAction Stop },
    [scriptblock]$ConfirmarSaida = { param($H) $H.Processo.Refresh(); $H.Processo.HasExited },
    [scriptblock]$DrenarSaida = { param($H) Wait-SyncFinanceiroSaidaDrenada -Processo $H.Processo },
    [scriptblock]$LiberarTracking = { param($H) Stop-SyncFinanceiroWorkerTracking -Handle $H | Out-Null },
    [int]$TimeoutDesfazimentoSegundos = 30,
    [int]$IntervaloSegundos = 1,
    [scriptblock]$Dormir = $script:DormirPadrao
  )
  $handle = $null
  try {
    $handle = & $IniciarProcesso
  } catch {
    $rStop = Set-SyncFinanceiroEstadoWorker -Raiz $Raiz -Estado 'Stopped' -GeracaoId $GeracaoId
    $sufixo = if (-not $rStop.Sucesso) { " (ADICIONALMENTE falha ao persistir Stopped: $($rStop.Erro))" } else { '' }
    return [pscustomobject]@{ Sucesso = $false; Handle = $null; Erro = "falha ao iniciar o processo: $($_.Exception.Message)$sufixo" }
  }

  try {
    $proc = $handle.Processo
    try {
      $startTimeUtc = $proc.StartTime.ToUniversalTime()
    } catch {
      throw "falha ao obter/converter StartTime do processo recem-criado: $($_.Exception.Message)"
    }
    if (-not $startTimeUtc) { throw 'falha ao obter StartTime do processo recem-criado: valor vazio/nulo' }
    $rRunning = Set-SyncFinanceiroEstadoWorker -Raiz $Raiz -Estado 'Running' -GeracaoId $GeracaoId -WorkerPid $proc.Id -StartTimeUtc $startTimeUtc
    if (-not $rRunning.Sucesso) { throw "falha ao registrar Running: $($rRunning.Erro)" }
    & $PosRunning $handle
  } catch {
    $erroOriginal = $_.Exception.Message
    $desfazimento = Invoke-SyncFinanceiroWatchdogDesfazerPartida -Raiz $Raiz -GeracaoId $GeracaoId -Handle $handle `
      -PararProcesso $PararProcesso -ConfirmarSaida $ConfirmarSaida -DrenarSaida $DrenarSaida -LiberarTracking $LiberarTracking `
      -TimeoutSegundos $TimeoutDesfazimentoSegundos -IntervaloSegundos $IntervaloSegundos -Dormir $Dormir
    $sufixoPersistencia = if (-not $desfazimento.EstadoPersistido) { ", FALHA ao persistir: $($desfazimento.ErroPersistencia)" } else { '' }
    return [pscustomobject]@{
      Sucesso = $false; Handle = $desfazimento.Handle
      Erro    = "$erroOriginal (worker desfeito, Confirmado=$($desfazimento.Confirmado), EstadoFinal=$($desfazimento.EstadoFinal)$sufixoPersistencia)"
    }
  }

  [pscustomobject]@{ Sucesso = $true; Handle = $handle; Erro = $null }
}

Export-ModuleMember -Function @(
  'Get-SyncFinanceiroFlagPath', 'Get-SyncFinanceiroRequestPath', 'Get-SyncFinanceiroAckPath', 'Get-SyncFinanceiroHeartbeatPath', 'Get-SyncFinanceiroEstadoPath', 'Get-SyncFinanceiroLockPath',
  'Invoke-SyncFinanceiroComLockEstado',
  'Get-SyncFinanceiroLockInstanciaPath', 'Invoke-SyncFinanceiroAdquirirLockInstancia', 'Close-SyncFinanceiroLockInstancia',
  'Test-SyncFinanceiroFlagPresente', 'New-SyncFinanceiroFlag', 'Remove-SyncFinanceiroFlag', 'Get-SyncFinanceiroFlagInfo',
  'Write-SyncFinanceiroRequest', 'Get-SyncFinanceiroRequestAtual', 'Get-SyncFinanceiroRequestIdDeParada',
  'Write-SyncFinanceiroAck', 'Get-SyncFinanceiroAckAtual',
  'Write-SyncFinanceiroHeartbeat', 'Get-SyncFinanceiroHeartbeatAtual', 'Test-SyncFinanceiroHeartbeatFresco',
  'Get-SyncFinanceiroWorkerProcessos', 'Test-SyncFinanceiroPararConfirmado', 'Invoke-SyncFinanceiroLimpezaLegadoWmi',
  'Wait-SyncFinanceiroCondicao',
  'Invoke-SyncFinanceiroParar', 'Get-SyncFinanceiroTarefaEstado', 'Start-SyncFinanceiroTarefaAgendada', 'Invoke-SyncFinanceiroLigar',
  'Get-SyncFinanceiroEstadoWorkerAtual', 'Set-SyncFinanceiroEstadoWorker', 'Initialize-SyncFinanceiroEstadoWorker',
  'Invoke-SyncFinanceiroWatchdogInicio', 'Invoke-SyncFinanceiroWatchdogInicioComRetentativas', 'Confirm-SyncFinanceiroParadaAposSaidaNatural',
  'Invoke-SyncFinanceiroWatchdogPararEConfirmar', 'Invoke-SyncFinanceiroWatchdogConfirmarInicio', 'Update-SyncFinanceiroWatchdogEmExecucao',
  'Invoke-SyncFinanceiroReconciliarWorkerAnterior',
  'Start-SyncFinanceiroWorkerProcesso', 'Stop-SyncFinanceiroWorkerTracking', 'Wait-SyncFinanceiroSaidaDrenada',
  'Invoke-SyncFinanceiroWatchdogDesfazerPartida', 'Invoke-SyncFinanceiroWatchdogPartidaTransacional'
)
