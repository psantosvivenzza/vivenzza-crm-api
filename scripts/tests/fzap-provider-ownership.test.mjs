import test from 'node:test'
import assert from 'node:assert/strict'
import { createWhatsappOwnershipStore } from '../../src/lib/whatsappOwnershipStore.js'
import { whatsappTransportFor } from '../../src/lib/whatsappProviderClient.js'

function fixture(initial, error = null, options = {}) {
  const row = initial && { ...initial }, writes = []
  let reads = 0
  const client = { from(table) {
    assert.equal(table, 'whatsapp_connections')
    let update, filters = []
    const query = {
      select() { return this }, eq(key, value) { filters.push([key, value]); return this }, maybeSingle() { return this },
      update(value) { update = value; return this }, abortSignal() { return this },
      then(resolve) {
        if (!update) reads++
        const matches = row && filters.every(([key, value]) => row[key] === value)
        if (!error && update && matches) { writes.push({ update, filters }); Object.assign(row, update) }
        return Promise.resolve({ data: matches ? { ...row } : null, error }).then(resolve)
      },
    }
    return query
  } }
  return { store: createWhatsappOwnershipStore({ client, ...options }), row, writes, get reads() { return reads }, setError(value) { error = value } }
}
const initial = { id: 'commercial', owner: 'evolution', migration_requested: false, instance_name: 'vivenzza', finalidade: 'comercial' }
const env = { FZAP_API_URL: 'https://fzap.vivenzzaprofessional.com.br', FZAP_CONNECTIONS_JSON: JSON.stringify([{ id: 'commercial', instanceName: 'vivenzza', nome: 'Comercial', finalidade: 'comercial', token: 'x'.repeat(40) }]) }
test('durable store imports without reading credentials and returns identity', async () => {
  const f = fixture(initial)
  assert.deepEqual(await f.store.get('commercial'), { owner: 'evolution', migrationRequested: false, instanceName: 'vivenzza', finalidade: 'comercial' })
})
test('complete requires durable intent, request then CAS completion; never downgrades', async () => {
  const f = fixture(initial)
  await assert.rejects(f.store.complete('commercial'), { code: 'FZAP_OWNERSHIP' })
  assert.equal(f.row.owner, 'evolution')
  assert.equal((await f.store.request('commercial')).migrationRequested, true)
  assert.equal((await f.store.complete('commercial')).owner, 'fzap')
  assert.equal(f.row.migration_requested, false)
  await f.store.request('commercial'); await f.store.complete('commercial')
  assert.equal(f.row.owner, 'fzap'); assert.equal(f.writes.length, 2)
  assert.ok(f.writes[1].filters.some(([key, value]) => key === 'migration_requested' && value === true))
})
test('missing row, invalid identity/state and database errors fail closed', async () => {
  for (const f of [fixture(null), fixture({ ...initial, owner: 'unknown' }), fixture({ ...initial, finalidade: 'unknown' }), fixture(initial, { message: 'secret' })]) {
    await assert.rejects(f.store.get('commercial'), (error) => error.code === 'FZAP_OWNERSHIP' && error.status === 503 && !JSON.stringify(error).includes('secret'))
  }
})
test('Evolution ownership does not require FZAP availability', async () => {
  const f = fixture(initial)
  let providerCalls = 0
  assert.equal(await whatsappTransportFor('vivenzza', { env, ownershipStore: f.store, transport: () => { providerCalls++; return null } }), 'evolution')
  assert.equal(providerCalls, 0)
})
test('provider does not downgrade FZAP after lost metadata or provider outage', async () => {
  const f = fixture({ ...initial, owner: 'fzap' })
  for (const transport of [async () => { throw new Error('offline') }, async () => ({ code: 200, success: true, data: { connected: true, loggedIn: true } }), async () => ({ code: 200, success: true, data: { connected: true, loggedIn: true, metadata: { vivenzza_crm_transport: 'fzap', vivenzza_crm_instance_name: 'vivenzza-financeiro' } } })]) {
    await assert.rejects(whatsappTransportFor('vivenzza', { env, ownershipStore: f.store, transport }), { code: 'FZAP_UNAVAILABLE' })
    assert.equal(f.row.owner, 'fzap')
  }
})
test('durable identity/config mismatch blocks provider request', async () => {
  const f = fixture({ ...initial, instance_name: 'vivenzza-financeiro', finalidade: 'financeiro' })
  await assert.rejects(whatsappTransportFor('vivenzza', { env, ownershipStore: f.store, transport: () => assert.fail('cross-channel request') }), { code: 'FZAP_OWNERSHIP' })
})
test('ownership reads coalesce bursts, expire at 2s, and never serve stale on errors', async () => {
  let clock = 1000
  const f = fixture(initial, null, { now: () => clock })
  const burst = await Promise.all(Array.from({ length: 30 }, () => f.store.get('commercial')))
  assert.equal(burst.length, 30); assert.equal(f.reads, 1)
  clock += 1999; await f.store.get('commercial'); assert.equal(f.reads, 1)
  clock += 1; f.setError({ message: 'isolated error' })
  await assert.rejects(f.store.get('commercial')); assert.equal(f.reads, 2)
  await assert.rejects(f.store.get('commercial')); assert.equal(f.reads, 3)
  f.setError(null); await f.store.get('commercial'); assert.equal(f.reads, 4)
})
test('request and complete invalidate cached ownership immediately despite TTL', async () => {
  const f = fixture(initial, null, { now: () => 1000 })
  await f.store.get('commercial'); assert.equal(f.reads, 1)
  assert.equal((await f.store.request('commercial')).migrationRequested, true); assert.equal(f.reads, 2)
  assert.equal((await f.store.complete('commercial')).owner, 'fzap'); assert.equal(f.reads, 3)
  assert.equal((await f.store.get('commercial')).owner, 'fzap'); assert.equal(f.reads, 3)
})
