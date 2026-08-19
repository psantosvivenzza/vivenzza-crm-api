@echo off
cd /d "%~dp0"
if not exist logs mkdir logs

echo Conferindo o ambiente...
node scripts\verificar-ambiente.mjs > saida-diagnostico.txt 2>&1
if errorlevel 1 goto erro

echo Ambiente OK. Preparando a sincronizacao continua...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\instalar-tarefa-sync-financeiro.ps1"
if errorlevel 1 goto erro_tarefa

echo.
echo Verificando se o worker ja esta rodando...
powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'sync-financeiro-legado.mjs' -and $_.CommandLine -match '--watch' } | Select-Object -First 1; if ($p) { Write-Output \"JA_RODANDO=$($p.ProcessId)\" } else { Write-Output 'JA_RODANDO=' }" > "%TEMP%\vivenzza-check.txt"
for /f "usebackq tokens=1,2 delims==" %%a in ("%TEMP%\vivenzza-check.txt") do set %%a=%%b
del /q "%TEMP%\vivenzza-check.txt" >nul 2>&1

if defined JA_RODANDO if not "%JA_RODANDO%"=="" (
  echo Worker ja esta rodando ^(PID %JA_RODANDO%^) - nada a iniciar.
) else (
  echo Nenhum worker ativo - iniciando via Tarefa Agendada...
  schtasks /run /tn "VivenzzaSyncFinanceiroLegado"
)

echo.
echo ============================================================
echo   PRONTO - sincronizacao continua rodando em background
echo ============================================================
echo.
echo   Roda a cada 60 segundos, via Tarefa Agendada do Windows
echo   ^(VivenzzaSyncFinanceiroLegado^).
echo   Reinicia sozinha se o processo cair - nao depende de
echo   nenhuma janela ficar aberta.
echo   Sobe sozinha no login E no boot da maquina.
echo.
echo   Acompanhe em: logs\sync-financeiro.log
echo.
echo   FALTA SO: abrir o CRM na tela Cobrancas e ligar o botao
echo   "Regua de Cobranca Automatica".
echo.
pause
exit /b 0

:erro
type saida-diagnostico.txt
echo.
echo ============================================================
echo   NAO LIGUEI NADA - resolva o que esta acima primeiro.
echo ============================================================
echo.
pause
exit /b 1

:erro_tarefa
echo.
echo ============================================================
echo   NAO CONSEGUI CRIAR/ATUALIZAR A TAREFA AGENDADA.
echo   Feche esta janela, abra o Prompt de Comando como
echo   Administrador e rode este 3-LIGAR.bat de novo.
echo ============================================================
echo.
pause
exit /b 1
