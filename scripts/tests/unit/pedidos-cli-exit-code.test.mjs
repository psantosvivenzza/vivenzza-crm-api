import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Executa o CLI real em processo descartável; substitui só dotenv e o job
// de banco ANTES de qualquer import. Não lê .env, não carrega dependências.
const hook = `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'dotenv/config') return {shortCircuit:true,url:'data:text/javascript,export {}'};
  if (specifier.endsWith('/jobs/sync-pedidos-legado.js')) return {shortCircuit:true,url:
    'data:text/javascript,'+encodeURIComponent('export async function executarSincronizacaoPedidos(){ if(process.env.VIVENZZA_PEDIDOS_CASE==="import_extra") await import("node:fs"); if(process.env.VIVENZZA_PEDIDOS_CASE==="throw") throw Error("synthetic failure"); return JSON.parse(process.env.VIVENZZA_PEDIDOS_REPORT); }')};
  if (specifier === ${JSON.stringify(new URL('../../sync-pedidos-legado.mjs', import.meta.url).href)}) return next(specifier, context);
  throw Error('Import não permitido na fixture');
} });`
const entry = fileURLToPath(new URL('../../sync-pedidos-legado.mjs', import.meta.url))

function run(report, mode = 'report') {
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(hook)}`, entry], {
    encoding: 'utf8', windowsHide: true, timeout: 10000,
    env: { SystemRoot: process.env.SystemRoot || '', VIVENZZA_PEDIDOS_CASE: mode, VIVENZZA_PEDIDOS_REPORT: JSON.stringify(report) },
  })
  assert.ifError(result.error)
  assert.equal(result.signal, null)
  if (mode === 'report') assert.match(result.stdout, /\[sync-pedidos-legado\]/, result.stderr)
  return result
}

test('clean completed report exits zero', () => {
  const result = run({ status: 'concluido', total_com_erro: 0 })
  assert.equal(result.status, 0)
})

for (const report of [
  { status: 'concluido_com_erros', total_com_erro: 2 },
  { status: 'concluido_com_erros', total_com_erro: 0 },
  { status: 'concluido', total_com_erro: 1 },
  { status: 'concluido', total_com_erro: -1 },
  { status: 'concluido', total_com_erro: '0' },
  { status: 'concluido', total_com_erro: 1.5 },
  { status: 'concluido', total_com_erro: null },
  { status: 'concluido', total_com_erro: false },
  { status: 'concluido' },
  { status: 'falhou', total_com_erro: 0 },
  { status: 'executando', total_com_erro: 0 },
  { status: 'unknown', total_com_erro: 0 },
  {}, null,
]) {
  test(`partial, inconsistent or malformed report fails closed: ${JSON.stringify(report)}`, () => {
    assert.equal(run(report).status, 1)
  })
}

test('job rejection remains nonzero', () => {
  const result = run(null, 'throw')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /synthetic failure/)
})

test('harness rejeita import extra antes de carregar dependência real', () => {
  const result = run(null, 'import_extra')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Import não permitido na fixture/)
  assert.doesNotMatch(result.stdout, /\[sync-pedidos-legado\]/)
})
