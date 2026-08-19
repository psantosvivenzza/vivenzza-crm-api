@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo Desligando SOMENTE a sincronizacao financeira...
echo (sync de PEDIDOS - VivenzzaSyncPedidosLegado - e Ollama nao sao tocados)
echo.

REM Sinaliza parada intencional e DA TEMPO do supervisor perceber sozinho
REM (poll a cada 5s) - ele roda no mesmo contexto do worker (S4U) e
REM consegue encerra-lo de forma limpa. Matar a tarefa na forca bruta
REM ANTES disso deixaria o worker orfao (o supervisor nunca chegaria a
REM ver o sinalizador), e tentar matar o worker diretamente desta janela
REM normalmente FALHA por permissao (mesma barreira de sessao do Windows
REM entre uma sessao interativa comum e um processo iniciado via Task
REM Scheduler/S4U) - por isso a parada graciosa e o caminho principal,
REM nao so um "best effort".
echo. > "logs\sync-financeiro.stop"
echo Aguardando o supervisor encerrar o worker de forma limpa...
timeout /t 8 /nobreak >nul

schtasks /end /tn "VivenzzaSyncFinanceiroLegado" >nul 2>&1
schtasks /change /tn "VivenzzaSyncFinanceiroLegado" /disable >nul 2>&1

REM Best-effort: se ainda sobrar algo vivo (ex: rodando este .bat como
REM Administrador), tenta encerrar direto. Falha silenciosa é esperada e
REM inofensiva quando rodado sem privilegio elevado - a parada graciosa
REM acima ja deveria ter resolvido.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'sync-financeiro-legado.mjs' -and $_.CommandLine -match '--watch' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'watchdog-sync-financeiro.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

del /q "logs\sync-financeiro.stop" >nul 2>&1

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
del /q "%STARTUP%\vivenzza-sync-financeiro.bat" 2>nul

echo.
echo Sincronizacao financeira desligada:
echo   - worker encerrado pelo proprio supervisor (parada limpa)
echo   - Tarefa Agendada encerrada e desabilitada
echo   - item antigo da pasta Startup removido, se existia
echo.
echo Rode 3-LIGAR.bat de novo quando quiser religar.
echo.
pause
