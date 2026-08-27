<#
.SYNOPSIS
  Instalador do lado Windows do servidor de voz - detecta WSL/Ubuntu, chama o
  instalador Linux (instalar-asterisk.sh) dentro da distro, e registra a
  recuperacao automatica apos reboot.

.DESCRIPTION
  Caminho PRINCIPAL para o servidor definitivo (Windows + WSL2 + Ubuntu +
  Asterisk nativo - o mesmo modelo ja homologado no laboratorio). Nenhum
  valor deste script e especifico de uma maquina: nome de distro, usuario
  WSL e caminho do repositorio sao todos parametros ou detectados em
  runtime, nunca hardcoded.

  Por padrao roda em modo PLANO (-Apply:$false) - so mostra o que faria.
  Passe -Apply para executar de verdade. Este script NÃO é executado como
  parte da tarefa que o criou - fica pronto para o servidor definitivo.

.PARAMETER DistroName
  Nome da distro WSL a usar (default: Ubuntu - mesma já homologada no lab).

.PARAMETER Apply
  Sem esta flag, só valida/relata o que seria feito (plano). Com ela,
  executa de fato (instala WSL/distro se faltar, chama o instalador Linux).

.EXAMPLE
  .\instalar-voice-server.ps1                # modo plano, nenhuma alteração
  .\instalar-voice-server.ps1 -Apply          # instalação de verdade
#>
[CmdletBinding()]
param(
  [string]$DistroName = "Ubuntu",
  [switch]$Apply
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$LinuxInstallerRelPath = "scripts/voice-server/instalar-asterisk.sh"

function Write-Step($msg) { Write-Host "[instalar-voice-server] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Fail($msg) { Write-Host "  [FALHOU] $msg" -ForegroundColor Red }
function Write-Info($msg) { Write-Host "  [info] $msg" -ForegroundColor DarkGray }

$falhas = 0

Write-Step "1/7 - detectar WSL"
$wslPresente = $false
try {
  $null = Get-Command wsl.exe -ErrorAction Stop
  $wslPresente = $true
  Write-Ok "wsl.exe encontrado"
} catch {
  Write-Fail "wsl.exe não encontrado - WSL2 precisa ser instalado primeiro (wsl --install, como Administrador, com reboot)"
  $falhas++
}

Write-Step "2/7 - detectar distro '$DistroName'"
$distroPresente = $false
if ($wslPresente) {
  $listaDistros = (wsl.exe -l -q 2>$null) -replace "`0", ""
  if ($listaDistros -match [regex]::Escape($DistroName)) {
    $distroPresente = $true
    Write-Ok "distro '$DistroName' presente"
  } else {
    Write-Fail "distro '$DistroName' não encontrada. Distros presentes: $($listaDistros -join ', ')"
    $falhas++
  }
}

Write-Step "3/7 - validar dependências (systemd habilitado no WSL)"
if ($distroPresente) {
  $wslConfCheck = wsl.exe -d $DistroName -e bash -c "grep -q '^systemd=true' /etc/wsl.conf 2>/dev/null && echo SIM || echo NAO"
  if ($wslConfCheck -match "SIM") {
    Write-Ok "/etc/wsl.conf já tem systemd=true (necessário para 'systemctl' funcionar dentro do WSL, e para o Asterisk subir sozinho quando a distro iniciar)"
  } else {
    Write-Fail "/etc/wsl.conf sem systemd=true - sem isso, systemctl não funciona dentro do WSL e o Asterisk não se recupera sozinho"
    Write-Info "correcao: dentro do WSL, adicionar [boot] / systemd=true em /etc/wsl.conf (sudo), depois 'wsl --shutdown' e reabrir a distro"
    $falhas++
  }
}

Write-Step "4/7 - chamar o instalador Linux ($LinuxInstallerRelPath)"
if ($distroPresente) {
  # Caminho do repo dentro do WSL - conversão automática via wslpath, nunca
  # um caminho C:\Users\<alguém> hardcoded.
  $linuxRepoPath = (wsl.exe -d $DistroName -e wslpath -u ($RepoRoot -replace '\\', '/')).Trim()
  $comando = "sudo bash '$linuxRepoPath/$LinuxInstallerRelPath'" + $(if (-not $Apply) { " --dry-run" } else { "" })
  Write-Info "comando: $comando"
  if ($Apply) {
    wsl.exe -d $DistroName -e bash -c $comando
    if ($LASTEXITCODE -ne 0) { Write-Fail "instalador Linux retornou erro (exit $LASTEXITCODE)"; $falhas++ }
    else { Write-Ok "instalador Linux concluído" }
  } else {
    Write-Info "modo plano (-Apply não passado) - instalador Linux NÃO foi executado de verdade"
  }
} else {
  Write-Info "pulado - distro não disponível"
}

Write-Step "5/7 - validar serviço Asterisk"
if ($distroPresente -and $Apply) {
  $ativo = (wsl.exe -d $DistroName -e systemctl is-active asterisk 2>$null).Trim()
  if ($ativo -eq "active") { Write-Ok "asterisk ativo" } else { Write-Fail "asterisk não está ativo (status: $ativo)"; $falhas++ }
} else {
  Write-Info "pulado (modo plano, ou distro indisponível)"
}

Write-Step "6/7 - validar portas (ARI 8088 loopback, SIP 5060/udp)"
if ($distroPresente -and $Apply) {
  wsl.exe -d $DistroName -e bash -c "$linuxRepoPath/scripts/voice-server/validar-voice-server.sh"
} else {
  Write-Info "pulado (modo plano, ou distro indisponível)"
}

Write-Step "7/7 - inicialização automática após reboot do Windows"
# WSL2 não inicia uma distro sozinho no boot do Windows - precisa de ALGO
# chamando 'wsl.exe' ao menos uma vez após o login/boot para a VM subir; a
# partir daí, systemd (passo 3) cuida de reerguer o Asterisk sozinho.
$nomeTarefa = "VivenzzaVoiceServerBoot"
if ($Apply) {
  $acao = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d $DistroName -e true"
  $gatilho = New-ScheduledTaskTrigger -AtStartup
  $config = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $nomeTarefa -Action $acao -Trigger $gatilho -Settings $config -Principal $principal -Force | Out-Null
  Write-Ok "tarefa agendada '$nomeTarefa' registrada (inicia a distro '$DistroName' a cada boot do Windows)"
} else {
  Write-Info "modo plano - tarefa agendada '$nomeTarefa' NÃO foi criada (rode com -Apply)"
}

Write-Host ""
if ($falhas -eq 0) {
  Write-Host "Resultado: OK ($falhas falha(s))." -ForegroundColor Green
} else {
  Write-Host "Resultado: $falhas falha(s) encontrada(s) - ver acima." -ForegroundColor Red
}
exit $falhas
