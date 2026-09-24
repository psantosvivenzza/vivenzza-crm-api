# Ancora permanente de disponibilidade do WSL2/Asterisk para a janela de
# cobranca por voz. Ve docs/cobranca-ai/ANCORA_WSL_ASTERISK.md para o
# contexto completo (incidente de origem, decisoes, rollback).
#
# O QUE ESTE SCRIPT FAZ (idempotente, seguro para rodar quantas vezes quiser):
#   1. Acorda a distro WSL se estiver parada (nao mexe em configuracao).
#   2. Garante que o systemd service 'asterisk' esta ativo dentro da distro
#      (so inicia se estiver inativo; nunca reinicia o que ja esta rodando).
#   3. Registra evidencia somente-leitura: trunk NVOIP, porta ARI, Ollama,
#      presenca dos workers de STT/TTS e se o servico de voz do Windows
#      esta no ar.
#
# O QUE ESTE SCRIPT NUNCA FAZ:
#   - Nao roda a fila de cobranca nem disca para ninguem.
#   - Nao amplia allowlist nem mexe em automacoes_config.
#   - Nao inicia/reinicia o servico de voz do Windows (run-voice-service) —
#     isso fica a cargo do fluxo manual existente (INICIAR-SERVICO-VOZ.ps1 /
#     npm run voice:service), que ja e protegido pelo guard de codigo
#     desatualizado em scripts/voice/verificar-servico-voz.mjs. Reiniciar o
#     servico de voz automaticamente aqui poderia colocar codigo local nao
#     revisado no ar bem antes de uma janela real de discagem.
#   - Nao altera .wslconfig nem configuracao do Asterisk.

param(
    [switch]$Verbose
)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.Encoding]::Unicode

$Distro = 'Ubuntu'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$LogDir = Join-Path $RepoRoot 'logs'
$LogFile = Join-Path $LogDir 'ancora-wsl-asterisk.log'
$MutexName = 'Global\VivenzzaAncoraWslAsterisk'

function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Output $line
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

if (-not (Test-Path $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Instancia unica: se outra execucao da ancora ja estiver rodando (dois
# gatilhos disparando quase juntos, por exemplo), esta sai sem fazer nada.
$mutex = New-Object System.Threading.Mutex($false, $MutexName)
$acquired = $false
try {
    $acquired = $mutex.WaitOne(0)
} catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
}

if (-not $acquired) {
    Write-Log 'Outra execucao da ancora ja esta em andamento. Saindo (instancia unica).'
    exit 0
}

try {
    Write-Log '--- Ancora WSL/Asterisk: inicio ---'

    # 1) Acorda a distro se estiver parada. Um comando trivial ja basta —
    #    isso NAO altera nenhuma configuracao, so garante que a VM/distro
    #    esta em pe.
    $antes = (wsl.exe -l -v 2>$null | Out-String)
    wsl.exe -d $Distro -u root -- true 2>&1 | Out-Null
    Start-Sleep -Seconds 2
    $depois = (wsl.exe -l -v 2>$null | Out-String)
    Write-Log "Estado WSL antes:`n$antes"
    Write-Log "Estado WSL depois:`n$depois"

    # 2) Asterisk: so inicia se nao estiver ativo. Nunca reinicia o que ja
    #    esta rodando (evita derrubar uma ligacao em andamento).
    $asteriskAtivo = (wsl.exe -d $Distro -u root -- systemctl is-active asterisk 2>$null | Out-String).Trim()
    if ($asteriskAtivo -ne 'active') {
        Write-Log "Asterisk nao estava ativo (status: '$asteriskAtivo'). Iniciando..."
        wsl.exe -d $Distro -u root -- systemctl start asterisk 2>&1 | ForEach-Object { Write-Log "  $_" }
        Start-Sleep -Seconds 3
        $asteriskAtivo = (wsl.exe -d $Distro -u root -- systemctl is-active asterisk 2>$null | Out-String).Trim()
    }
    Write-Log "Asterisk (systemctl is-active): $asteriskAtivo"

    # 3) Evidencia somente-leitura a partir daqui — nada abaixo altera estado.
    $trunk = (wsl.exe -d $Distro -u root -- asterisk -rx 'pjsip show registrations' 2>$null | Out-String)
    Write-Log "NVOIP trunk (pjsip show registrations):`n$trunk"

    $portas = wsl.exe -d $Distro -u root -- ss -ltn 2>$null
    $ariUp = $false
    if ($portas) { $ariUp = [bool]($portas | Select-String ':8088' -Quiet) }
    Write-Log "ARI (porta 8088 dentro da distro): $(if ($ariUp) { 'LISTENING' } else { 'DOWN' })"

    try {
        $ollama = Invoke-WebRequest -Uri 'http://127.0.0.1:11434/api/version' -UseBasicParsing -TimeoutSec 3
        Write-Log "Ollama (Windows, 127.0.0.1:11434): up — $($ollama.Content)"
    } catch {
        Write-Log "Ollama (Windows, 127.0.0.1:11434): DOWN — $($_.Exception.Message)"
    }

    $servicoVoz = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'run-voice-service' } |
        Select-Object -First 1
    if ($servicoVoz) {
        Write-Log "Servico de voz (Windows): rodando — PID $($servicoVoz.ProcessId), desde $($servicoVoz.CreationDate)"
    } else {
        Write-Log 'Servico de voz (Windows): NAO esta rodando. Fora de escopo desta ancora (nao inicia sozinha) — suba manualmente com INICIAR-SERVICO-VOZ.ps1 / npm run voice:service antes da janela, se precisar.'
    }

    foreach ($rel in @('scripts\voice\tts_worker.py', 'scripts\voice\stt_worker.py', 'scripts\voice\tts_synthesize.py', 'scripts\voice\stt_transcribe.py')) {
        $p = Join-Path $RepoRoot $rel
        Write-Log "$rel : $(if (Test-Path $p) { 'presente' } else { 'AUSENTE' })"
    }

    Write-Log '--- Ancora WSL/Asterisk: fim ---'
}
catch {
    # Qualquer falha aqui (wsl.exe travado, systemctl sem resposta, WSL2
    # lento para acordar depois de horas ocioso, etc.) virava um stack trace
    # cru do PowerShell e nada no log — quem olhasse o log via achar que a
    # ancora nao tinha rodado. Agora vira uma linha objetiva e saida != 0.
    # Fail-closed sem efeito colateral: esta ancora nunca disca nem altera
    # configuracao, entao falhar aqui so significa evidencia incompleta
    # nesta rodada, nao um estado inseguro.
    Write-Log "FALHA NA ANCORA: $($_.Exception.Message)"
    exit 1
}
finally {
    $mutex.ReleaseMutex() | Out-Null
    $mutex.Dispose()
}
