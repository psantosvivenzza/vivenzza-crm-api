import { test, assert } from './helpers/caught-assertions.mjs'
import { fzapWebhookSecret } from '../../src/lib/fzapWebhookSecret.js'
import { readFileSync } from 'node:fs'
import { createEvolutionOwnershipMiddleware, createFzapWebhookHandler } from '../../src/lib/whatsappInboundOwnership.js'

const secret = 'test-only-'.repeat(5)
const env = { FZAP_WEBHOOK_SECRET: secret, SDR_SITE_INSTANCE: 'site' }
const connections = [
  { id: 'fin', instanceName: 'financial', finalidade: 'financeiro' },
  { id: 'sales', instanceName: 'commercial', finalidade: 'comercial' },
  { id: 'site', instanceName: 'site', finalidade: 'comercial' },
]
const getConfig = () => ({ connections })
function response() {
  return { statusCode: 200, headersSent: false, status(code) { this.statusCode = code; return this }, json(body) { assert.equal(this.headersSent, false, 'single response'); this.body = body; this.headersSent = true; return this } }
}
function request(id = 'fin') { return { params: { id }, headers: { 'x-fzap-webhook-token': fzapWebhookSecret(secret, id) }, body: { instance: 'forged', token: secret } } }

for (const owner of ['fzap', 'evolution', 'indeterminado']) {
  test(`Evolution gate: owner ${owner}`, async () => {
    let called = 0
    const gate = createEvolutionOwnershipMiddleware({ getConfig, transportFor: async () => owner })
    const res = response()
    await gate({ body: { instance: 'financial' } }, res, () => called++)
    assert.equal(called, owner === 'evolution' ? 1 : 0)
    assert.equal(res.statusCode, owner === 'indeterminado' ? 503 : 200)
    if (owner === 'fzap') assert.equal(res.body.status, 'ignored')
  })
}
test('Evolution unavailable/config malformed/missing identity fail closed, unrelated stays legacy', async () => {
  for (const body of [{}, { instance: 'financial' }]) {
    const res = response()
    await createEvolutionOwnershipMiddleware({ getConfig, transportFor: async () => { throw Error('private detail') } })({ body }, res, () => assert.fail())
    assert.equal(res.statusCode, 503)
    assert.ok(!JSON.stringify(res.body).includes('private'))
  }
  let next = 0
  await createEvolutionOwnershipMiddleware({ getConfig })({ body: { instance: 'other' } }, response(), () => next++)
  await createEvolutionOwnershipMiddleware({ getConfig: () => null })({}, response(), () => next++)
  assert.equal(next, 2)
  const res = response()
  await createEvolutionOwnershipMiddleware({ getConfig: () => { throw Error() } })({}, res, () => assert.fail())
  assert.equal(res.statusCode, 503)
})

test('FZAP header required; body token and arrays never authenticate', async () => {
  for (const header of [undefined, '', 'wrong', [secret]]) {
    const req = request(); req.headers['x-fzap-webhook-token'] = header
    const res = response()
    await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: () => assert.fail() })(req, res)
    assert.equal(res.statusCode, 401)
  }
  const res = response()
  await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env: {}, getConfig })(request(), res)
  assert.equal(res.statusCode, 503)
})
test('FZAP unknown id blocked before ownership or dispatch', async () => {
  const res = response()
  await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: () => assert.fail() })(request('unlisted'), res)
  assert.equal(res.statusCode, 404)
})
test('FZAP ownership gates do not acknowledge failures as processed', async () => {
  for (const owner of ['evolution', 'indeterminado', 'failure']) {
    const res = response()
    await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: async () => { if (owner === 'failure') throw Error(); return owner }, normalize: () => assert.fail() })(request(), res)
    assert.equal(res.statusCode, owner === 'evolution' ? 200 : 503)
  }
})
for (const [id, expected] of [['fin', 'financial'], ['sales', 'commercial'], ['site', 'site']]) {
  test(`FZAP ${id} dispatches once, using configured identity`, async () => {
    const seen = []
    const handler = createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: async () => 'fzap',
      normalize: (_, instance) => ({ event: 'messages.upsert', instance, data: {} }),
      financial: async (event) => seen.push(['financial', event]),
      commercial: async (req, res) => { seen.push(['commercial', req.body]); res.json({ status: 'received' }) },
      site: async (req, res) => { seen.push(['site', req.body]); res.json({ status: 'received' }) },
    })
    await handler(request(id), response())
    assert.equal(seen.length, 1)
    assert.equal(seen[0][0], expected)
    assert.equal(seen[0][1].instance, connections.find((c) => c.id === id).instanceName)
    assert.equal(seen[0][1].token, undefined)
  })
}
test('Unknown events ignored, callback failures safe, no callback duplicated after acknowledgement', async () => {
  const base = { env, getConfig, transportFor: async () => 'fzap' }
  const ignored = response()
  await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, ...base, normalize: () => null, financial: () => assert.fail() })(request(), ignored)
  assert.equal(ignored.body.status, 'ignored')
  const failure = response()
  await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, ...base, normalize: () => ({}), financial: () => { throw Error(secret) } })(request(), failure)
  assert.equal(failure.statusCode, 503)
  assert.ok(!JSON.stringify(failure).includes(secret))
  const acked = response()
  await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, ...base, normalize: () => ({}), commercial: (_, res) => { res.json({ status: 'received' }); throw Error() } })(request('sales'), acked)
  assert.equal(acked.statusCode, 200)
})
test('SDR integration routes both legacy entries through ownership and retains site guards', () => {
  const source = readFileSync(new URL('../../src/routes/sdr.js', import.meta.url), 'utf8')
  assert.match(source, /router.post\('\/webhook', webhookAuth, evolutionOwnership,/)
  assert.match(source, /router.post\('\/site-reativacao\/webhook', webhookAuth, evolutionOwnership,/)
  assert.match(source, /export async function handleSiteCampaignWebhook/)
  assert.match(source, /export function handleFzapSdrWebhook/)
  assert.match(source, /sdrContext.run\(\{ instance, provider: 'fzap' \}, \(\) => handleSdrWebhook\(req, res\)\)/)
  assert.match(source, /const context = siteCampaignContext\(req.body\)/)
  assert.match(source, /stop_site_campaign_contact/)
  assert.match(source, /if\(recipient.status==='blocked'\)/)
})

const message = (_, instance) => ({ event: 'messages.upsert', instance, data: { key: { id: 'ID1', remoteJid: '100@s.whatsapp.net', fromMe: false } } })
test('Replay: reserve before dispatch, concurrent unacked retry503, acknowledged duplicate ignored', async () => {
  let release, entered, count = 0
  const started = new Promise((r) => { entered = r })
  const pending = new Promise((r) => { release = r })
  const handler = createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: async () => 'fzap', normalize: message,
    financial: async () => { count++; entered(); await pending } })
  const first = response(), task = handler(request(), first)
  await started
  const concurrent = response(); await handler(request(), concurrent)
  assert.equal(concurrent.statusCode, 503)
  release(); await task
  const duplicate = response(); await handler(request(), duplicate)
  assert.equal(duplicate.body.status, 'ignored')
  assert.equal(count, 1)
})
test('Replay: preack failure releases reservation, postack failure retains it', async () => {
  let count = 0
  const handler = createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: async () => 'fzap', normalize: message,
    financial: async () => { count++; if (count === 1) throw Error() } })
  const failed = response(); await handler(request(), failed); assert.equal(failed.statusCode, 503)
  await handler(request(), response()); assert.equal(count, 2)
  let commercialCalls = 0
  const ackHandler = createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: async () => 'fzap', normalize: message,
    commercial: async (_, res) => { commercialCalls++; res.json({ status: 'received' }); throw Error() } })
  await ackHandler(request('sales'), response()); await ackHandler(request('sales'), response())
  assert.equal(commercialCalls, 1)
})
test('Replay: TTL six hours, capacity failclosed and per-connection identity', async () => {
  let time = 0, count = 0
  const handler = createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env, getConfig, transportFor: async () => 'fzap', normalize: message, now: () => time, dedupMaxEntries: 1,
    financial: async () => count++, commercial: async (_, res) => { count++; res.json({ status: 'received' }) } })
  await handler(request(), response())
  const full = response(); await handler(request('sales'), full); assert.equal(full.statusCode, 503)
  time = 6 * 60 * 60 * 1000 - 1
  await handler(request(), response()); assert.equal(count, 1)
  time++
  await handler(request('sales'), response()); assert.equal(count, 2)
})

test('Evolution default gate reads only durable owner and validates configured identity', async () => {
  for (const owner of ['fzap', 'evolution']) {
    let calls = 0, next = 0
    const res = response()
    const gate = createEvolutionOwnershipMiddleware({ getConfig, store: { get: async (id) => {
      calls++; assert.equal(id, 'fin'); return { owner, instanceName: 'financial', finalidade: 'financeiro' }
    } } })
    await gate({ body: { instance: 'financial' } }, res, () => next++)
    assert.equal(calls, 1); assert.equal(next, owner === 'evolution' ? 1 : 0)
    if (owner === 'fzap') assert.equal(res.body.status, 'ignored')
  }
  for (const row of [null, { owner: 'fzap', instanceName: 'other', finalidade: 'financeiro' }, { owner: 'fzap', instanceName: 'financial', finalidade: 'comercial' }]) {
    const res = response()
    await createEvolutionOwnershipMiddleware({ getConfig, store: { get: async () => row } })({ body: { instance: 'financial' } }, res, () => assert.fail())
    assert.equal(res.statusCode, 503)
  }
})

test('Real SDR handler runs Lara before inbox persistence; receipts bypass Lara', async () => {
  const { runInNewContext } = await import('node:vm')
  const source = readFileSync(new URL('../../src/routes/sdr.js', import.meta.url), 'utf8')
  const start = source.indexOf('export async function handleSdrWebhook(')
  const end = source.indexOf('\n// Called only after the FZAP route', start)
  assert.ok(start >= 0 && end > start)
  const calls = []
  const context = { processarLara: async () => { calls.push('lara'); return null }, processWhatsappEvent: async () => calls.push('inbox'),
    sdrContext: { getStore: () => null }, console: { error: () => assert.fail() } }
  const handle = runInNewContext(source.slice(start, end).replace('export ', '') + '\nhandleSdrWebhook', context)
  await handle({ body: { event: 'messages.upsert' } }, { json: () => calls.push('ack') })
  assert.deepEqual(calls, ['ack', 'lara', 'inbox'])
  calls.length = 0
  await handle({ body: { event: 'messages.update' } }, { json: () => calls.push('ack') })
  assert.deepEqual(calls, ['ack', 'inbox'])
})


test('segredo por conexão não autentica outro canal nem aceita master', async () => {
  for (const header of [secret, fzapWebhookSecret(secret, 'sales')]) {
    const req = request('fin'); req.headers['x-fzap-webhook-token'] = header
    const res = response()
    await createFzapWebhookHandler({ financialCheck: async (instance) => instance === "financial", logger: {error: () => {}}, env })(req, res)
    assert.equal(res.statusCode, 401)
  }
})

test('FZAP financial registry mismatch/error blocks all callbacks; commercial cannot use registered financial channel', async () => {
  for (const [id, result] of [['fin', false], ['fin', 'failure'], ['sales', true], ['site', true]]) {
    const res = response()
    await createFzapWebhookHandler({ env, getConfig, transportFor: async () => 'fzap', normalize: message,
      financialCheck: async () => { if (result === 'failure') throw Error('private'); return result },
      financial: () => assert.fail(), commercial: () => assert.fail(), site: () => assert.fail(),
    })(request(id), res)
    assert.equal(res.statusCode, 503)
  }
})
test('financial callback receives strict expected domain, late classification failure returns503 beforeACK', async () => {
  const res = response()
  await createFzapWebhookHandler({ env, getConfig, transportFor: async () => 'fzap', normalize: message,
    financialCheck: async () => true, financial: async (_, options) => { assert.equal(options.financialExpected, true); throw Error('private') },
  })(request(), res)
  assert.equal(res.statusCode, 503)
})
test('after-ACK failure logs only fixed code and safe connection id', async () => {
  const logs = []
  await createFzapWebhookHandler({ env, getConfig, transportFor: async () => 'fzap', normalize: message,
    financialCheck: async () => false, logger: { error: (...args) => logs.push(args) },
    commercial: async (_, res) => { res.json({ status: 'received' }); throw Error(secret) },
  })(request('sales'), response())
  assert.equal(logs.length, 1)
  assert.equal(logs[0][1].code, 'FZAP_INBOUND_AFTER_ACK_FAILED')
  assert.equal(logs[0][1].connection_id, 'sales')
  assert.ok(!JSON.stringify(logs).includes(secret))
})
test('real financial processor rejects false/error outside legacy catch before any effect', async () => {
  const { runInNewContext } = await import('node:vm')
  const source = readFileSync(new URL('../../src/routes/webhook-handler.js', import.meta.url), 'utf8')
  const start = source.indexOf('export async function processWhatsappEvent(')
  const end = source.indexOf('export default async function handleWebhook', start)
  for (const check of [async () => false, async () => { throw Error('database detail') }]) {
    let sideEffects = 0
    const handler = runInNewContext(source.slice(start, end).replace('export ', '') + '\nprocessWhatsappEvent', {
      ehInstanciaFinanceira: check, supabase: { from: () => { sideEffects++; assert.fail() } },
      console: { error: () => assert.fail() },
    })
    await assert.rejects(handler({ event: 'messages.upsert', instance: 'financial', data: {} }, { financialExpected: true }), e => e.code === 'FZAP_FINANCIAL_CLASSIFICATION')
    assert.equal(sideEffects, 0)
  }
})
