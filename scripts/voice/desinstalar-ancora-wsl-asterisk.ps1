# Rollback da ancora WSL/Asterisk: remove so a tarefa agendada.
# Nao desliga WSL/Asterisk que ja estejam rodando (isso e proposital: a
# ligacao/servico ao vivo nao deve cair so porque a ancora foi desinstalada).
#
# Para tambem desligar a VM do WSL manualmente depois: wsl --shutdown

$ErrorActionPreference = 'Stop'
$TaskName = 'VivenzzaAncoraWslAsteriskVoz'

$t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $t) {
    Write-Host "Tarefa '$TaskName' nao existe — nada a fazer." -ForegroundColor Yellow
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "Tarefa '$TaskName' removida." -ForegroundColor Green
Write-Host 'Observacao: WSL/Asterisk que ja estejam rodando continuam no ar. Para desligar manualmente: wsl --shutdown' -ForegroundColor Cyan
