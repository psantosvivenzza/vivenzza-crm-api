import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// Guards estáticos: não executam PowerShell, BAT, scheduler ou worker.
test('watchdog inicia o worker com alertas desabilitados', () => {
  const texto = fs.readFileSync(new URL('../watchdog-sync-financeiro.ps1', import.meta.url), 'utf8')
  // Falha fechado se aparecer outra chamada, inclusive com variável ou layout diferente.
  const codigo = texto.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n')
  assert.equal((codigo.match(/\bStart-SyncFinanceiroWorkerProcesso\b/g) || []).length, 1)
  const partidas = texto.split(/\r?\n/).filter(l => /^\s*\$h\s*=\s*Start-SyncFinanceiroWorkerProcesso\b/.test(l))
  assert.equal(partidas.length, 1)
  assert.match(partidas[0], /-FileName 'node\.exe' -Argumentos "\$nomeScriptWorker --watch --sem-alertas"/)
  assert.doesNotMatch(partidas[0], /--dry-run/)
})

test('lançador manual preserva append do log e também suprime alertas', () => {
  const texto = fs.readFileSync(new URL('../../vivenzza-sync-financeiro.bat', import.meta.url), 'utf8')
  const partidas = texto.split(/\r?\n/).filter(l => /^\s*node\s+scripts\\sync-financeiro-legado\.mjs\b/.test(l))
  assert.equal(partidas.length, 1)
  assert.match(partidas[0], /^node scripts\\sync-financeiro-legado\.mjs --watch --sem-alertas >> logs\\sync-financeiro\.log 2>&1\s*$/)
})
