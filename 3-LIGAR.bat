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

echo Tarefa OK. Ligando a sincronizacao financeira...
echo.

REM Fase 2E (3a rodada): nao precisa mais de privilegio elevado - o script
REM abaixo NUNCA chama Enable-ScheduledTask em caminho nenhum (a tarefa so
REM e religada quando ja esta instalada, consultavel e Enabled=True; se
REM estiver Disabled, nao existir, ou a consulta falhar por acesso negado,
REM ele falha com a mensagem REAL e orienta reparo administrativo, sem
REM tentar reabilitar/elevar sozinho). So DEPOIS dessa validacao remove o
REM sinalizador de parada e CONFIRMA a ausencia (transacional: se o worker
REM nao for confirmado de pe pelo WATCHDOG a tempo, o sinalizador e
REM restaurado automaticamente antes do script terminar - nunca fica
REM removido "no ar"). So sai com sucesso depois que o watchdog confirma o
REM worker de pe usando o handle real do processo Node (nao mais o cmd.exe
REM que o lancava, e nunca WMI) - nunca antes disso.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ligar-sync-financeiro.ps1"
if errorlevel 1 goto erro_ligar

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

:erro_ligar
echo.
echo ============================================================
echo   NAO CONSEGUI LIGAR - veja a mensagem acima antes de tentar de novo.
echo ============================================================
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
