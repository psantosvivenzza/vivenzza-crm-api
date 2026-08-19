@echo off
cd /d "C:\Users\msi\Projeto Claude Code\vivenzza-crm-api"
node scripts\sync-financeiro-legado.mjs --watch >> logs\sync-financeiro.log 2>&1
