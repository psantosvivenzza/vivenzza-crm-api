@echo off
cd /d "%~dp0"
if not exist logs mkdir logs

echo Conferindo o ambiente...
node scripts\verificar-ambiente.mjs > saida-diagnostico.txt 2>&1
if errorlevel 1 goto erro

echo Ambiente OK. Verificando a Tarefa Agendada...
echo.

REM So chama o instalador (que exige Administrador) se a tarefa nao
REM existir ainda ou nao estiver apontando pro supervisor correto - nao
REM precisa elevacao so pra iniciar/ligar algo que ja esta configurado
REM certo.
powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName 'VivenzzaSyncFinanceiroLegado' -ErrorAction SilentlyContinue; if (-not $t) { Write-Output 'PRECISA_INSTALAR' } elseif (($t.Actions[0].Arguments) -notmatch 'watchdog-sync-financeiro\.ps1') { Write-Output 'PRECISA_INSTALAR' } else { Write-Output 'OK' }" > "%TEMP%\vivenzza-tarefa-check.txt"
set /p TAREFA_STATUS=<"%TEMP%\vivenzza-tarefa-check.txt"
del /q "%TEMP%\vivenzza-tarefa-check.txt" >nul 2>&1

if "%TAREFA_STATUS%"=="PRECISA_INSTALAR" goto precisa_admin

echo Tarefa OK. Verificando se o worker ja esta rodando...
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'sync-financeiro-legado.mjs' -and $_.CommandLine -match '--watch' } | Select-Object -First 1; if ($p) { Write-Output \"JA_RODANDO=$($p.ProcessId)\" } else { Write-Output 'JA_RODANDO=' }" > "%TEMP%\vivenzza-check.txt"
for /f "usebackq tokens=1,2 delims==" %%a in ("%TEMP%\vivenzza-check.txt") do set %%a=%%b
del /q "%TEMP%\vivenzza-check.txt" >nul 2>&1

if defined JA_RODANDO if not "%JA_RODANDO%"=="" (
  echo Worker ja esta rodando ^(PID %JA_RODANDO%^) - nada a iniciar.
) else (
  echo Nenhum worker ativo - limpando sinalizador de parada, se houver...
  del /q "logs\sync-financeiro.stop" >nul 2>&1
  echo Iniciando via Tarefa Agendada...
  schtasks /run /tn "VivenzzaSyncFinanceiroLegado"
)

echo.
echo ============================================================
echo   PRONTO - sincronizacao continua rodando em background
echo ============================================================
echo.
echo   Task Scheduler ^(VivenzzaSyncFinanceiroLegado^) vigia um
echo   supervisor, que por sua vez vigia o worker e reinicia
echo   sozinho se o processo cair. Nao depende de nenhuma janela
echo   ficar aberta.
echo   Sobe sozinha no login E no boot da maquina.
echo.
echo   Acompanhe em: logs\sync-financeiro.log
echo.
echo   FALTA SO: abrir o CRM na tela Cobrancas e ligar o botao
echo   "Regua de Cobranca Automatica".
echo.
pause
exit /b 0

:precisa_admin
echo.
echo ============================================================
echo   PRIMEIRA CONFIGURACAO DESTA MAQUINA - PRECISA DE ADMIN
echo ============================================================
echo.
echo   Abra o PowerShell "Executar como administrador" e rode:
echo.
echo   powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\instalar-tarefa-sync-financeiro.ps1"
echo.
echo   Depois rode este 3-LIGAR.bat de novo normalmente.
echo.
pause
exit /b 1

:erro
type saida-diagnostico.txt
echo.
echo ============================================================
echo   NAO LIGUEI NADA - resolva o que esta acima primeiro.
echo ============================================================
echo.
pause
exit /b 1
