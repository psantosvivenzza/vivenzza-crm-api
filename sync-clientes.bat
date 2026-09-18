@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" scripts\sync-clientes-legado.mjs >> logs\sync-clientes.log 2>&1
