import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createHash } from 'node:crypto'

// Module graph only: actual webhook + wrapper + advisor; all external dependencies
// are synthetic. This does not execute an inbound event, SDK, database or provider.
test('actual webhook links actual observer and advisor without external work', async () => {
  const calls = { database: 0, provider: 0, model: 0, timer: 0 }
  const deny = key => () => { calls[key]++; throw Error('EXTERNAL_WORK_FORBIDDEN') }
  const context = vm.createContext({
    process: { env: {} }, AbortSignal,
    setTimeout: deny('timer'), clearTimeout() {},
    console: { log() {}, warn() {}, error() {} },
  })
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
  }, { context })
  const modules = new Map()
  const actualPaths = [
    '../../src/routes/webhook-handler.js',
    '../../src/lib/commercialConversationObserver.js',
    '../../src/lib/leadStageAdvisor.js',
  ].map(path => new URL(path, import.meta.url).href)
  for (const url of actualPaths) modules.set(url, new vm.SourceTextModule(fs.readFileSync(new URL(url), 'utf8'), {
    context, identifier: url,
    importModuleDynamically: async () => { calls.model++; throw Error('SDK_IMPORT_FORBIDDEN') },
  }))
  const fakes = {
    'axios': { default: { create: () => ({ get: deny('provider'), post: deny('provider'), request: deny('provider') }) } },
    'supabase-admin.server.js': { supabase: { from: deny('database'), rpc: deny('database') } },
    'telefone.js': { candidatosTelefone() {}, mascararTelefone() {}, normalizarTelefone() {}, telefonesEquivalentes() {} },
    'distribuicao.js': { criarOuObterLeadWhatsapp: deny('database') },
    'ctwa.js': { detectarCtwaClid() {}, caminhosIndicioAnuncio() {} },
    'clienteErpMatch.js': { buscarClienteErpPorTelefone: deny('database') },
    'reativacao.js': { detectarRespostaReativacao: deny('database') },
    'catalogos.js': { CATALOGOS_POR_NOME_ARQUIVO: {} },
    'dispatchEngine.js': { aplicarAckDeEntrega: deny('database') },
    'whatsappInstances.js': { ehInstanciaFinanceira() {} },
    'inbound.js': { handleFreteInbound: deny('provider') },
    'featureFlags.js': { obterConfigCobranca: deny('database') },
  }
  const configSource = fs.readFileSync(new URL('../../src/lib/collection/featureFlags.js', import.meta.url), 'utf8')
  const instanceSource = fs.readFileSync(new URL('../../src/lib/collection/whatsappInstances.js', import.meta.url), 'utf8')
  assert.ok(/export\s+async\s+function\s+obterConfigCobranca\s*\(/.test(configSource), 'Expected config export declaration')
  assert.ok(/export\s+(?:async\s+)?function\s+ehInstanciaFinanceira\s*\(/.test(instanceSource), 'Expected instance export declaration')
  const webhook = modules.get(actualPaths[0])
  const linked = []
  await webhook.link((specifier, referencing) => {
    if (specifier === 'node:crypto') return synthetic({ createHash })
    const resolved = new URL(specifier, referencing.identifier).href
    if (modules.has(resolved)) { linked.push(resolved); return modules.get(resolved) }
    if (specifier.startsWith('.')) assert.ok(fs.existsSync(new URL(resolved)), `Missing dependency ${specifier}`)
    const name = specifier === 'axios' ? 'axios' : specifier.split('/').at(-1)
    assert.ok(Object.hasOwn(fakes, name), `Unexpected import ${specifier}`)
    return synthetic(fakes[name])
  })
  await webhook.evaluate()
  assert.equal(typeof webhook.namespace.processWhatsappEvent, 'function')
  assert.equal(typeof webhook.namespace.default, 'function')
  assert.equal(typeof modules.get(actualPaths[1]).namespace.observeCommercialStage, 'function')
  assert.equal(typeof modules.get(actualPaths[2]).namespace.createLeadStageAdvisor, 'function')
  assert.deepEqual(new Set(linked), new Set(actualPaths.slice(1)))
  assert.deepEqual(calls, { database: 0, provider: 0, model: 0, timer: 0 })
})
