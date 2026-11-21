import test from 'node:test'
import { createHash } from 'node:crypto'
const ownJid = '5511000000999@s.whatsapp.net'
const ownHash = createHash('sha256').update('5511000000999').digest('hex')
import assert from 'node:assert/strict'
import { createWhatsappProviderClient, WhatsappProviderError } from '../../src/lib/whatsappProviderClient.js'
import { classifyEvolutionFailure } from '../../src/lib/collection/evolutionAdapter.js'

// Explicit fictitious credentials; network is forbidden by the injected clients.
process.env.SUPABASE_URL = 'https://isolated-fzap-test.invalid'
process.env.SUPABASE_SECRET_KEY = 'fictitious-test-key'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fictitious-test-key'
delete process.env.LOCAL_PG_URL
const { runEvolutionHealthCheck } = await import('../../src/jobs/evolution-health.js')

test('all indeterminate FZAP failures fail closed before generic HTTP/network classification', () => {
  for (const code of ['FZAP_UNCERTAIN', 'FZAP_UNAVAILABLE', 'FZAP_CONFIG', 'FZAP_UNSUPPORTED']) {
    const result = classifyEvolutionFailure(new WhatsappProviderError(code, 503))
    assert.equal(result.failoverEligible, false)
    assert.equal(result.affectsInstanceHealth, false)
    assert.equal(result.category, 'UNKNOWN')
    assert.equal(result.failureKind, 'unknown') // Existing SQL CHECK permits it.
  }
})
test('known FZAP auth/rate rejection remains classified without failover', () => {
  for (const [status, expected] of [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMIT']]) {
    const result = classifyEvolutionFailure(new WhatsappProviderError('FZAP_REJECTED', status))
    assert.equal(result.category, expected); assert.equal(result.failoverEligible, false)
  }
})
test('legacy transport errors retain existing taxonomy', () => {
  assert.equal(classifyEvolutionFailure({ code: 'ECONNREFUSED', message: 'teste' }).failoverEligible, true)
  assert.equal(classifyEvolutionFailure({ response: { status: 503 }, message: 'teste' }).category, 'TECHNICAL_RETRYABLE')
  assert.equal(classifyEvolutionFailure({ numeroInvalido: true, message: 'teste' }).affectsInstanceHealth, false)
})
test('health checks authoritative FZAP even while Evolution inventory/provider is unavailable', async () => {
  const fzapRequests = [], legacyRequests = [], records = [], updates = []
  const env = { FZAP_API_URL: 'https://fzap.vivenzzaprofessional.com.br', FZAP_CONNECTIONS_JSON: JSON.stringify([{ id: 'test', instanceName: 'vivenzza-financeiro', nome: 'Teste', finalidade: 'financeiro', token: 'x'.repeat(40) }]) }
  const client = createWhatsappProviderClient({}, { env,
    ownershipStore: {get:async()=>({owner:'fzap',instanceName:'vivenzza-financeiro',finalidade:'financeiro'})},
    axiosImpl: { create: () => ({ get: async (path) => { legacyRequests.push(path); throw new Error('Evolution offline') } }) },
    transport: async (request) => { fzapRequests.push(request); return { code: 200, success: true, data: { jid: ownJid, connected: true, loggedIn: true, metadata: { vivenzza_crm_expected_jid_sha256: ownHash, vivenzza_crm_transport: 'fzap', vivenzza_crm_instance_name:'vivenzza-financeiro' } } } },
  })
  await runEvolutionHealthCheck({ client, instances: ['vivenzza', 'vivenzza-financeiro'],
    record: async (name, state) => { records.push([name, state]); return { instancia: name, status: state } },
    update: async (...args) => updates.push(args),
  })
  assert.deepEqual(records, [['vivenzza', 'error'], ['vivenzza-financeiro', 'open']])
  assert.deepEqual(legacyRequests, ['/instance/connectionState/vivenzza'])
  assert.deepEqual(updates, [['vivenzza-financeiro', 'open']])
  assert.equal(fzapRequests.length, 1); assert.equal(fzapRequests[0].path, '/session/status')
})
test('health records indeterminate ownership as error and never changes provider', async () => {
  let legacyCalls = 0
  const env = { FZAP_API_URL: 'https://fzap.vivenzzaprofessional.com.br', FZAP_CONNECTIONS_JSON: JSON.stringify([{ id: 'test', instanceName: 'vivenzza', nome: 'Teste', finalidade: 'comercial', token: 'x'.repeat(40) }]) }
  const client = createWhatsappProviderClient({}, { env, ownershipStore:{get:async()=>({owner:'fzap',instanceName:'vivenzza',finalidade:'comercial'})}, axiosImpl: { create: () => ({ get: () => { legacyCalls++; throw new Error() } }) }, transport: async () => { throw new Error('FZAP unavailable') } })
  const records = []
  await runEvolutionHealthCheck({ client, instances: ['vivenzza'], record: async (name, state) => { records.push([name, state]); return { instancia: name, status: state } }, update: async () => assert.fail('indeterminate status must not overwrite status') })
  assert.deepEqual(records, [['vivenzza', 'error']]); assert.equal(legacyCalls, 0)
})
test('legacy 404 records not_found and updates instance registry', async () => {
  const records = [], updates = []
  await runEvolutionHealthCheck({client:{get:async()=>{throw {response:{status:404},message:'absent'}}},instances:['legacy-absent'],record:async(name,status)=>{records.push([name,status]);return {instancia:name,status}},update:async(...args)=>updates.push(args)})
  assert.deepEqual(records,[['legacy-absent','not_found']]);assert.deepEqual(updates,[['legacy-absent','not_found']])
})
test('health uses at most two concurrent checks and preserves configured result order', async () => {
  let active = 0, maximum = 0
  const gates = []
  const client = {get:async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>gates.push(resolve));active--;return {data:{instance:{state:'open'}}}}}
  const pending = runEvolutionHealthCheck({client,instances:['a','b','c','d'],record:async(name,status)=>({instancia:name,status}),update:async()=>{}})
  await new Promise(resolve=>setImmediate(resolve));assert.equal(gates.length,2)
  gates[0]();gates[1]();await new Promise(resolve=>setImmediate(resolve));assert.equal(gates.length,4)
  gates[2]();gates[3]();const results=await pending
  assert.equal(maximum,2);assert.deepEqual(results.map(item=>item.instancia),['a','b','c','d'])
})
