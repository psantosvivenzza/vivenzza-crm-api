import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
const cli = fileURLToPath(new URL('../financeiro-progress-health.mjs', import.meta.url))
const e = (evento, idade) => JSON.stringify({ tipo: 'financeiro_etapa', etapa: 'sincronizacao_incremental', evento, em: new Date(Date.now() - idade).toISOString(), segredo: 'NAO_IMPRIMIR' })
const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
for (const [nome, input, args, status, estado] of [
  ['fim recente', () => e('fim', 60000), [], 0, 'ok'],
  ['conclusão antiga', () => e('fim', 660000), [], 1, 'atrasado'],
  ['falha da etapa', () => e('erro', 60000), [], 1, 'erro'],
  ['entrada vazia', () => '', [], 2, 'inconclusivo'],
  ['entrada excessiva', () => 'x'.repeat(256 * 1024 + 1), [], 2, 'inconclusivo'],
  ['argumento desconhecido', () => e('fim', 60000), ['--reiniciar'], 2, 'inconclusivo'],
]) test(`CLI: ${nome}`, () => {
  const r = spawnSync(process.execPath, [cli, ...args], { input: input(), encoding: 'utf8', env, timeout: 8000 })
  // Fechamento intencional durante entrada excessiva/argumento rejeitado pode
  // interromper o pipe do pai. Só tolerar após validar saída e exit esperados.
  if (!(status === 2 && r.error?.code === 'EPIPE')) assert.ifError(r.error)
  assert.equal(r.status, status, r.stderr)
  assert.equal(JSON.parse(r.stdout).estado, estado)
  assert.doesNotMatch(r.stdout + r.stderr, /NAO_IMPRIMIR/)
})
test('CLI: stdin que permanece aberto expira sem imprimir a entrada', { timeout: 9000 }, async t => {
  const child = spawn(process.execPath, [cli], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill())
  let stdout = '', stderr = ''
  child.stdout.on('data', b => { stdout += b })
  child.stderr.on('data', b => { stderr += b })
  const [codigo, sinal] = await once(child, 'close')
  assert.equal(codigo, 2)
  assert.equal(sinal, null)
  assert.deepEqual(JSON.parse(stdout), { estado: 'inconclusivo' })
  assert.equal(stderr, '')
})
