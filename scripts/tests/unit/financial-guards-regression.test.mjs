// No database, sockets, dotenv or production client initialization.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'

// An existing dependency tree may be supplied for an isolated worktree (no install).
const require = createRequire(process.env.VIVENZZA_TEST_PACKAGE_JSON ?? new URL('../../../package.json', import.meta.url))
const { PostgrestClient } = require('@supabase/postgrest-js')

// Only this isolated test process; never load environment files.
delete process.env.COBRANCA_EXIGE_SYNC
delete process.env.COBRANCA_SYNC_MAX_ATRASO_MIN

const fixtureKey = Symbol.for('vivenzza.financial-guards.regression')
const fixture = globalThis[fixtureKey] = { responses: {}, queries: [] }
fixture.client = {
  rpc(name,args) {
    if(fixture.httpClient)return fixture.httpClient.rpc(name,args)
    return Promise.resolve(fixture.responses.rpc ?? {data:{dispatches:0,promessaCumprida:false,ligacoes:0,motivo:null},error:null})
  },
  from(table) {
    if (fixture.httpClient) return fixture.httpClient.from(table)
    fixture.queries.push(table)
    const query = new Proxy({}, {
      get(_target, key) {
        if (key === 'then') return (resolve, reject) => Promise.resolve(fixture.responses[table] ?? { data: [], error: null }).then(resolve, reject)
        return () => query
      },
    })
    return query
  },
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? ''
    if (parent.endsWith('/src/lib/localdev/pgCompatClient.js') && specifier === 'pg') {
      const source = `export default { Pool: class { async query() { throw globalThis[Symbol.for('vivenzza.financial-guards.regression')].pgError } } }`
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    if (/\/src\/lib\/collection\/(financialSyncGuard|paymentGuard)\.js$/.test(parent)) {
      let source
      if (specifier.endsWith('/supabase-admin.server.js')) source = `export const supabase = globalThis[Symbol.for('vivenzza.financial-guards.regression')].client`
      if (specifier === './timeline.js') source = 'export const ORIGEM = {}; export async function registrarEvento() { throw new Error("unexpected timeline mutation") }'
      if (specifier === './promises.js') source = 'export async function promessaAtivaPara() { throw new Error("unexpected promise lookup") }; export async function marcarPromessaCumprida() { throw new Error("unexpected promise mutation") }'
      if (source) return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { verificarFrescorSync } = await import('../../../src/lib/collection/financialSyncGuard.js')
const { varrerTitulosPendentesEcancelarQuitados } = await import('../../../src/lib/collection/paymentGuard.js')
const { cancelarAutomacaoPorPagamento } = await import('../../../src/lib/collection/paymentGuard.js')
const now = Date.parse('2026-10-15T12:00:00Z')

for (const [name, status, offsetMs, errors, allowed, reason] of [
  ['fresh completed', 'concluido', -60000, 0, true, null],
  ['exact present timestamp', 'concluido', 0, 0, true, null],
  ['stale completed', 'concluido', -300 * 60000, 0, false, 'sync_stale'],
  ['failed', 'falhou', 0, 0, false, 'ultimo_sync_falhou'],
  ['running', 'executando', 0, 0, false, 'ultimo_sync_em_andamento'],
  ['partial with errors', 'concluido_com_erros', 0, 1, false, 'ultimo_sync_com_erros'],
  ['partial with inconsistent zero counter', 'concluido_com_erros', 0, 0, false, 'ultimo_sync_com_erros'],
  ['unknown status', 'unexpected', 0, 0, false, 'ultimo_sync_status_invalido'],
  ['future by one millisecond', 'concluido', 1, 0, false, 'timestamp_futuro'],
  ['future by one day', 'concluido', 86400000, 0, false, 'timestamp_futuro'],
]) {
  test(`sync guard: ${name}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now })
    fixture.responses = { sincronizacoes_financeiro: { data: { status, concluido_em: new Date(now + offsetMs).toISOString(), total_com_erro: errors }, error: null } }
    const result = await verificarFrescorSync({ ignorarCache: true })
    assert.equal(result.allowed, allowed)
    assert.equal(result.reason, reason)
  })
}

const tables = ['collection_dispatches', 'collection_promises', 'collection_calls']
for (const table of tables) {
  test(`sweep propagates query failure: ${table}`, async () => {
    const error = { code: 'SYNTHETIC_DB_ERROR' }
    fixture.responses = { [table]: { data: null, error } }
    await assert.rejects(varrerTitulosPendentesEcancelarQuitados(), (actual) => actual === error)
  })
}
test('sweep tolerates only absent optional collection_calls table', async () => {
  fixture.responses = { collection_calls: { data: null, error: { code: '42P01' } } }
  assert.deepEqual(await varrerTitulosPendentesEcancelarQuitados(), { verificados: 0, quitados: 0 })
})
test('sweep does not swallow missing mandatory tables', async () => {
  for (const table of tables.slice(0, 2)) {
    const error = { code: '42P01' }
    fixture.responses = { [table]: { data: null, error } }
    await assert.rejects(varrerTitulosPendentesEcancelarQuitados(), (actual) => actual === error)
  }
})
test('empty successful sweep', async () => {
  fixture.responses = {}
  assert.deepEqual(await varrerTitulosPendentesEcancelarQuitados(), { verificados: 0, quitados: 0 })
})
test('optional missing call table preserves titles from mandatory tables and deduplicates them', async () => {
  fixture.responses = {
    collection_dispatches: { data: [{ contas_financeiras_id: 'synthetic-title' }], error: null },
    collection_promises: { data: [{ contas_financeiras_id: 'synthetic-title' }], error: null },
    collection_calls: { data: null, error: { code: '42P01' } },
    contas_financeiras: { data: { valor: 10, valor_pago: 0, status: 'aberta' }, error: null },
  }
  assert.deepEqual(await varrerTitulosPendentesEcancelarQuitados(), { verificados: 1, quitados: 0 })
})
test('sweep aborts discovery before reconciling any title on query error', async () => {
  const error = { code: 'SYNTHETIC_DB_ERROR' }
  fixture.queries = []
  fixture.responses = {
    collection_dispatches: { data: [{ contas_financeiras_id: 'synthetic-title' }], error: null },
    collection_promises: { data: null, error },
  }
  await assert.rejects(varrerTitulosPendentesEcancelarQuitados(), (actual) => actual === error)
  assert.equal(fixture.queries.includes('contas_financeiras'), false)
})

function mockHttp(t, respond) {
  const requests = []
  fixture.httpClient = new PostgrestClient('https://synthetic.invalid/rest/v1', {
    retry: false,
    fetch: async (url, options) => {
      const table = new URL(url).pathname.split('/').at(-1)
      const method = options?.method ?? 'GET'
      requests.push({ table, method, body: options?.body ? JSON.parse(options.body) : null })
      const response = respond(table, method, new URL(url), options?.body ? JSON.parse(options.body) : null)
      return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { 'Content-Type': 'application/json' } })
    },
  })
  t.after(() => { fixture.httpClient = null })
  return requests
}
function missingTable(code) {
  return { status: 404, body: { code, message: 'synthetic missing table', details: null, hint: null } }
}
for (const code of ['PGRST205', '42P01']) {
  test(`sweep tolerates optional missing table via HTTP client: ${code}`, async (t) => {
    mockHttp(t, (table) => table === 'collection_calls' ? missingTable(code) : { body: [] })
    assert.deepEqual(await varrerTitulosPendentesEcancelarQuitados(), { verificados: 0, quitados: 0 })
  })
  for (const table of ['collection_dispatches', 'collection_promises']) {
    test(`missing mandatory table still rejects via HTTP client: ${table}/${code}`, async (t) => {
      const requests = mockHttp(t, (current) => current === table ? missingTable(code) : { body: [] })
      await assert.rejects(varrerTitulosPendentesEcancelarQuitados(), (error) => error.code === code)
      assert.equal(requests.some((r) => r.method !== 'GET'), false)
    })
  }
}
for (const code of ['42501', '08006', 'ECONNRESET', 'PGRST204', 'PGRST2050', '42P010']) {
  test(`optional table never swallows other errors: ${code}`, async (t) => {
    mockHttp(t, (table) => table === 'collection_calls'
      ? { status: 503, body: { code, message: 'synthetic failure' } } : { body: [] })
    await assert.rejects(varrerTitulosPendentesEcancelarQuitados(), (error) => error.code === code)
  })

}
test('optional table propagates rejected fetch (network failure)', async (t) => {
  fixture.httpClient = new PostgrestClient('https://synthetic.invalid/rest/v1', { retry: false, fetch: async (url) => {
    if (new URL(url).pathname.endsWith('/collection_calls')) throw new TypeError('synthetic network failure')
    return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
  } })
  t.after(() => { fixture.httpClient = null })
  await assert.rejects(varrerTitulosPendentesEcancelarQuitados())
})
test('real local SQL adapter preserves missing optional table SQLSTATE without a database', async () => {
  const { createLocalPgClient } = await import('../../../src/lib/localdev/pgCompatClient.js')
  const error = Object.assign(new Error('synthetic undefined table'), { code: '42P01' })
  fixture.pgError = error
  const client = createLocalPgClient('synthetic-no-connection')
  const result = await client.from('collection_calls').select('contas_financeiras_id')
  assert.equal(result.error.code, '42P01')
  fixture.responses = { collection_calls: result }
  assert.deepEqual(await varrerTitulosPendentesEcancelarQuitados(), { verificados: 0, quitados: 0 })
})

for (const broken of ['first', 'last', 'all', 'none']) {
  test(`one title failure does not starve remaining reconciliation: ${broken}`, async (t) => {
    const titles = ['synthetic-first', 'synthetic-last']
    const seen = []
    const isBroken = (id) => broken === 'all' || (broken === 'first' && id === titles[0]) || (broken === 'last' && id === titles[1])
    const requests = mockHttp(t, (table, method, url, body) => {
      if (table === 'collection_cancel_paid_atomic') {
        const id = body.p_title_id
        seen.push(id)
        return isBroken(id) ? { status: 400, body: { code: 'SYNTHETIC_FAILURE', message: 'sensitive synthetic title detail' } } : { body: {dispatches:1,promessaCumprida:false,ligacoes:0,motivo:'cancelado'} }
      }
      if (table === 'collection_dispatches') {
        if (url.searchParams.get('select') === 'contas_financeiras_id') return { body: titles.map(contas_financeiras_id => ({ contas_financeiras_id })) }
        return { body: [{ id: 'synthetic-dispatch' }] }
      }
      if (table === 'collection_calls') return missingTable('PGRST205')
      return { body: [] }
    })
    let failure
    let result
    try { result = await varrerTitulosPendentesEcancelarQuitados() } catch (error) { failure = error }
    if (broken === 'none') {
      assert.equal(failure, undefined)
      assert.deepEqual(result, { verificados: 2, quitados: 2 })
      assert.deepEqual(seen, titles)
      assert.equal(requests.filter(r => r.method === 'POST').length, 2)
      return
    }
    assert.ok(failure instanceof AggregateError)
    assert.equal(failure.code, 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE')
    assert.deepEqual(seen, titles)
    assert.deepEqual(failure.resultado, { verificados: 2, quitados: broken === 'all' ? 0 : 1, falhas: broken === 'all' ? 2 : 1 })
    assert.equal(failure.errors.length, broken === 'all' ? 2 : 1)
    assert.ok(failure.errors.every(error => error.code === 'SYNTHETIC_FAILURE'))
    assert.doesNotMatch(failure.message, /synthetic|sensitive|title detail/)
    assert.equal(requests.filter(r => r.method === 'POST').length, 2)
  })
}

// Per-title optional-table semantics now run in the actual SQL cluster.
for(const code of ['PGRST202','42P01','PGRST205','42501','08006','P0001'])test('RPC failure propagates without non-atomic fallback: '+code,async(t)=>{
  const requests=mockHttp(t,(name)=>name==='collection_cancel_paid_atomic'?{status:400,body:{code,message:'SYNTHETIC'}}:{body:[]})
  await assert.rejects(()=>cancelarAutomacaoPorPagamento('synthetic-title'),e=>e.code===code)
  assert.equal(requests.length,1);assert.equal(requests[0].method,'POST');assert.deepEqual(requests[0].body,{p_title_id:'synthetic-title'})
})
