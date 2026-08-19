@echo off
echo Desligando SOMENTE a sincronizacao financeira...
echo (o sync de PEDIDOS - VivenzzaSyncPedidosLegado - nao e tocado)
echo.

schtasks /end /tn "VivenzzaSyncFinanceiroLegado" >nul 2>&1
schtasks /change /tn "VivenzzaSyncFinanceiroLegado" /disable >nul 2>&1

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'sync-financeiro-legado.mjs' -and $_.CommandLine -match '--watch' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

set STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
del /q "%STARTUP%\vivenzza-sync-financeiro.bat" 2>nul

echo.
echo Sincronizacao financeira desligada:
echo   - Tarefa Agendada desabilitada
echo   - processo do worker encerrado ^(se algum administrador
echo     tiver que rodar isso sem privilegio elevado, o processo
echo     pode nao morrer - a tarefa desabilitada ja impede reinicio^)
echo   - item antigo da pasta Startup removido, se existia
echo.
echo Rode 3-LIGAR.bat de novo quando quiser religar.
echo.
pause
