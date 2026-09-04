@echo off
cd /d "%~dp0"
if not exist logs mkdir logs
echo Desligando SOMENTE a sincronizacao financeira...
echo (sync de PEDIDOS - VivenzzaSyncPedidosLegado - e Ollama nao sao tocados)
echo.

REM Fase 2E (3a rodada): parada normal nao precisa mais de privilegio
REM elevado nem de schtasks /end ou /change /disable (a tarefa pode
REM continuar Enabled=True para sempre - o sinalizador persistente em
REM logs\sync-financeiro.stop e o unico mecanismo de controle, ver
REM scripts\sync-financeiro-control.psm1 e scripts\watchdog-sync-financeiro.ps1).
REM O script abaixo so imprime sucesso depois que o WATCHDOG confirma a
REM parada usando o handle real do processo Node (nao mais o cmd.exe que o
REM lancava) - nunca WMI, e nunca uma "ausencia generica de processo": a
REM limpeza de orfaos de uma geracao anterior e so best-effort e, sozinha,
REM NAO decide esse resultado.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\parar-sync-financeiro.ps1"
set EXITCODE=%ERRORLEVEL%

echo.
if "%EXITCODE%"=="0" (
  echo Rode 3-LIGAR.bat de novo quando quiser religar.
) else (
  echo A parada NAO foi confirmada - veja a mensagem acima antes de tentar de novo.
)
echo.
pause
exit /b %EXITCODE%
