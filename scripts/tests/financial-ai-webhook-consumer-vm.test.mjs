import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const webhookUrl = new URL('../../src/routes/webhook-handler.js', import.meta.url)
const source = fs.readFileSync(webhookUrl, 'utf8')
const start = source.indexOf('    const { error: erroUpsertMensagem }')
const end = source.indexOf('    if (mediaTipo && evolutionId)', start)
assert.ok(start > 0 && end > start, 'Expected persistence block anchors')
const block = source.slice(start, end)

async function run({ financial = true, fromMe = false, freight = false, id = true,
  errors = [null], reject = false } = {}) {
  const calls = { upsert: 0, inbound: [], outbound: [], logs: [] }
  const context = {
    supabase: { from: () => ({ upsert: async () => ({ error: errors[calls.upsert++] ?? null }) }) },
    payloadMensagem: { fixture: true }, instanceName: 'fixture-financial',
    ehFinanceiro: financial, freteInbound: freight, fromMe,
    evolutionId: id ? 'fixture-event' : null, telefone: 'fixture-phone', texto: 'fixture-text',
    msg: { messageTimestamp: 123456 },
    processFinancialInbound: async input => { calls.inbound.push(input); if (reject) throw Error('PRIVATE_FIXTURE') },
    observeFinancialOutbound: async input => { calls.outbound.push(input); if (reject) throw Error('PRIVATE_FIXTURE') },
    console: { warn() {}, error: (...args) => calls.logs.push(args) },
  }
  await vm.runInNewContext('(async () => {' + block + '})()', context)
  await new Promise(setImmediate)
  return calls
}

test('persisted financial input forwards provider event id and timestamp once', async () => {
  const c = await run()
  assert.equal(c.upsert, 1)
  assert.equal(JSON.stringify(c.inbound), JSON.stringify([{ id: 'fixture-event', timestamp: 123456 }]))
  assert.equal(c.outbound.length, 0)
})

test('persisted financial output forwards its own instance and identity once', async () => {
  const c = await run({ fromMe: true })
  assert.equal(c.upsert, 1)
  assert.equal(c.inbound.length, 0)
  assert.equal(JSON.stringify(c.outbound), JSON.stringify([{
    phone: 'fixture-phone', instance: 'fixture-financial', providerId: 'fixture-event', text: 'fixture-text',
  }]))
})

test('commercial directions never enter financial handlers', async () => {
  for (const fromMe of [false, true]) {
    const c = await run({ financial: false, fromMe })
    assert.equal(c.inbound.length + c.outbound.length, 0)
  }
})

test('freight contexts and missing provider id never enter financial handlers', async () => {
  for (const input of [{ freight: true }, { freight: { semCotacao: true } }, { id: false }]) {
    const c = await run(input)
    assert.equal(c.inbound.length + c.outbound.length, 0)
  }
})

test('primary persistence errors and legacy fallback keep production financial exclusion', async () => {
  for (const errors of [[{ code: 'FIXTURE', message: 'FIXTURE' }],
    [{ code: 'PGRST204', message: 'FIXTURE' }, null],
    [{ code: 'PGRST204', message: 'FIXTURE' }, { code: 'FIXTURE', message: 'FIXTURE' }]]) {
    const c = await run({ errors })
    assert.equal(c.inbound.length + c.outbound.length, 0)
    assert.equal(c.upsert, errors[0].code === 'PGRST204' ? 2 : 1)
  }
})

test('rejected downstream operation has fixed diagnostic without retry or raw error', async () => {
  for (const fromMe of [false, true]) {
    const c = await run({ fromMe, reject: true })
    assert.equal(c.inbound.length + c.outbound.length, 1)
    assert.equal(c.upsert, 1)
    assert.deepEqual(c.logs, [['[financial-ai] inbound_processing_unavailable']])
  }
})

test('actual webhook links actual financial runtime and policy without external work', async () => {
  assert.equal(globalThis[Symbol.for('vivenzza.tests.networkGuardInstalled')], true)
  const calls = { database: 0, provider: 0, model: 0, timer: 0 }
  const deny = name => () => { calls[name]++; throw Error('EXTERNAL_WORK_FORBIDDEN') }
  const context = vm.createContext({ process: { env: {} }, AbortSignal, Date,
    setTimeout: deny('timer'), clearTimeout() {}, console: { log() {}, warn() {}, error() {} } })
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
  }, { context })
  const urls = [webhookUrl.href, new URL('../../src/lib/financialAiRuntime.js', import.meta.url).href,
    new URL('../../src/lib/financialAiPolicy.js', import.meta.url).href]
  const actual = new Map(urls.map(url => [url, new vm.SourceTextModule(fs.readFileSync(new URL(url), 'utf8'), {
    context, identifier: url, importModuleDynamically: async () => { throw Error('UNEXPECTED_DYNAMIC_IMPORT') },
  })]))
  class FakeAI { messages = { create: deny('model') } }
  const provider = { get: deny('provider'), post: deny('provider'), request: deny('provider') }
  const fakes = {
    axios: { default: { create: () => provider } },
    '@anthropic-ai/sdk': { default: FakeAI },
    [new URL('../../src/lib/supabase-admin.server.js', import.meta.url).href]: { supabase: { from: deny('database'), rpc: deny('database') } },
    [new URL('../../src/lib/whatsappProviderClient.js', import.meta.url).href]: { createWhatsappProviderClient: () => provider, whatsappTransportFor: deny('provider') },
    [new URL('../../src/lib/telefone.js', import.meta.url).href]: { candidatosTelefone() {}, mascararTelefone() {}, normalizarTelefone() {}, telefonesEquivalentes() {} },
    [new URL('../../src/lib/distribuicao.js', import.meta.url).href]: { criarOuObterLeadWhatsapp: deny('database') },
    [new URL('../../src/lib/ctwa.js', import.meta.url).href]: { detectarCtwaClid() {}, caminhosIndicioAnuncio() {} },
    [new URL('../../src/lib/clienteErpMatch.js', import.meta.url).href]: { buscarClienteErpPorTelefone: deny('database') },
    [new URL('../../src/routes/reativacao.js', import.meta.url).href]: { detectarRespostaReativacao: deny('database') },
    [new URL('../../src/lib/catalogos.js', import.meta.url).href]: { CATALOGOS_POR_NOME_ARQUIVO: {} },
    [new URL('../../src/lib/collection/dispatchEngine.js', import.meta.url).href]: { aplicarAckDeEntrega: deny('database') },
    [new URL('../../src/lib/collection/whatsappInstances.js', import.meta.url).href]: { ehInstanciaFinanceira() {} },
    [new URL('../../src/lib/fretes/inbound.js', import.meta.url).href]: { handleFreteInbound: deny('provider') },
    [new URL('../../src/lib/collection/financialSyncGuard.js', import.meta.url).href]: { verificarFrescorSync: deny('database') },
    [new URL('../../src/lib/collection/doNotContactGuard.js', import.meta.url).href]: { estaEmDoNotContact: deny('database') },
    [new URL('../../src/lib/collection/collectionContactPolicy.js', import.meta.url).href]: { dentroDaJanela() {} },
    [new URL('../../src/lib/siteCampaignPolicy.js', import.meta.url).href]: { isStopRequest() {} },
    [new URL('../../src/lib/collection/ai/intentClassifier.js', import.meta.url).href]: { CLASSIFY_SYSTEM_PROMPT: 'fixture', validarClassificacao() {} },
  }
  const linked = new Set()
  await actual.get(urls[0]).link((specifier, referencing) => {
    const resolved = new URL(specifier, referencing.identifier).href
    if (actual.has(resolved)) { linked.add(resolved); return actual.get(resolved) }
    if (specifier.startsWith('.')) assert.ok(fs.existsSync(new URL(resolved)), 'Expected relative producer file')
    const name = specifier.startsWith('.') ? resolved : specifier
    assert.ok(Object.hasOwn(fakes, name), `Unexpected import ${specifier}`)
    return synthetic(fakes[name])
  })
  await actual.get(urls[0]).evaluate()
  assert.equal(typeof actual.get(urls[0]).namespace.processWhatsappEvent, 'function')
  assert.deepEqual(linked, new Set(urls.slice(1)))
  assert.equal(typeof actual.get(urls[1]).namespace.processFinancialInbound, 'function')
  assert.equal(typeof actual.get(urls[1]).namespace.observeFinancialOutbound, 'function')
  assert.equal(typeof actual.get(urls[2]).namespace.createFinancialInboundProcessor, 'function')
  assert.deepEqual(calls, { database: 0, provider: 0, model: 0, timer: 0 })
})
