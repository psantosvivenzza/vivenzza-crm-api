@echo off
REM Fila de ligacao de cobranca por voz.
REM
REM Roda 16h, 17h e 18h em dias uteis: a faixa de 16h em diante teve 83%% de
REM atendimento (10 de 12) contra 25%% antes das 11h (4 de 16). Mesma operacao,
REM mesmo custo, quase 3x mais gente atendendo.
REM
REM Os guards continuam todos valendo: janela legal ate 18h40 (lei estadual RS
REM 15.608/2014), teto de 8 ligacoes/hora e 40/dia, 1 por telefone por dia, e a
REM fila so traz quem esta realmente elegivel.
cd /d "%~dp0"

REM Pre-voo: nao disca se o servico de voz estiver parado ou rodando codigo
REM velho. Foi exatamente isso que fez 3 clientes cairem em caixa postal
REM gravada como conversa em 18/09.
"C:\Program Files\nodejs\node.exe" scripts\voice\verificar-servico-voz.mjs >> logs\fila-cobranca.log 2>&1
if errorlevel 1 (
  echo [fila-cobranca] ABORTADO pelo pre-voo - ver acima. >> logs\fila-cobranca.log
  exit /b 1
)

"C:\Program Files\nodejs\node.exe" scripts\voice\rodar-fila-cobranca.mjs --limite=8 --confirm >> logs\fila-cobranca.log 2>&1
