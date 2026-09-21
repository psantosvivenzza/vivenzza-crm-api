// Auditoria 2026-09-20 — versiona sync-pedidos.bat, o wrapper que o Task
// Scheduler da máquina do NetVision já executa de verdade (tarefa
// `VivenzzaSyncPedidosLegado`, Action = este .bat, confirmado via
// Get-ScheduledTask). O arquivo nunca tinha sido commitado; o script real que
// ele chama (scripts/sync-pedidos-legado.mjs -> src/jobs/sync-pedidos-legado.js)
// já está versionado desde o commit 2aa6b3a.
//
// Este teste é só um guard estrutural/estático — sem rede, sem e01, sem
// Supabase, sem child_process. Existe pra pegar uma regressão boba e real:
// alguém editar o .bat (ou renomear/mover o .mjs) sem perceber que quebra a
// tarefa agendada, já que o Task Scheduler aponta para o CAMINHO do .bat, não
// para o conteúdo dele — nada mais valida essa costura.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RAIZ = path.join(__dirname, '..', '..')
const CAMINHO_BAT = path.join(RAIZ, 'sync-pedidos.bat')

test('sync-pedidos.bat existe na raiz do repo', () => {
  assert.ok(fs.existsSync(CAMINHO_BAT), `esperado ${CAMINHO_BAT}`)
})

test('sync-pedidos.bat é um wrapper cmd válido (@echo off + cd /d "%~dp0")', () => {
  const conteudo = fs.readFileSync(CAMINHO_BAT, 'utf8')
  assert.match(conteudo, /^@echo off\r?\n/, 'precisa começar com @echo off')
  assert.match(conteudo, /cd \/d "%~dp0"/, 'precisa fixar o diretório de trabalho no diretório do próprio .bat')
})

test('sync-pedidos.bat invoca scripts\\sync-pedidos-legado.mjs (não outro script)', () => {
  const conteudo = fs.readFileSync(CAMINHO_BAT, 'utf8')
  assert.match(
    conteudo,
    /node\.exe"?\s+scripts\\sync-pedidos-legado\.mjs\b/,
    'o Task Scheduler (VivenzzaSyncPedidosLegado) espera exatamente esse script'
  )
})

test('sync-pedidos.bat redireciona stdout+stderr para logs\\sync-pedidos.log (append, não overwrite)', () => {
  const conteudo = fs.readFileSync(CAMINHO_BAT, 'utf8')
  assert.match(conteudo, />>\s*logs\\sync-pedidos\.log\s+2>&1/, 'precisa ser >> (append) com stderr redirecionado, senão silencia falhas')
})

test('o script referenciado pelo .bat existe de fato no repo (scripts/sync-pedidos-legado.mjs)', () => {
  const alvo = path.join(RAIZ, 'scripts', 'sync-pedidos-legado.mjs')
  assert.ok(fs.existsSync(alvo), `sync-pedidos.bat aponta para um arquivo que não existe: ${alvo}`)
})

test('scripts/sync-pedidos-legado.mjs por sua vez chama a implementação real versionada (src/jobs/sync-pedidos-legado.js)', () => {
  const alvo = path.join(RAIZ, 'scripts', 'sync-pedidos-legado.mjs')
  const conteudo = fs.readFileSync(alvo, 'utf8')
  assert.match(
    conteudo,
    /from ['"]\.\.\/src\/jobs\/sync-pedidos-legado\.js['"]/,
    'a cadeia .bat -> .mjs -> job real precisa continuar íntegra'
  )
  assert.ok(
    fs.existsSync(path.join(RAIZ, 'src', 'jobs', 'sync-pedidos-legado.js')),
    'src/jobs/sync-pedidos-legado.js precisa existir — é a implementação real'
  )
})
