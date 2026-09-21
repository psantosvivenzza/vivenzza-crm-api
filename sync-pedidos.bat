@echo off
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" scripts\sync-pedidos-legado.mjs >> logs\sync-pedidos.log 2>&1
