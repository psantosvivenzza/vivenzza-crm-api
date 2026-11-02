import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fzapWebhookSecret } from '../../src/lib/fzapWebhookSecret.js'
import { readFzapConfig, createFzapConnectionsService as makeService, fzapSessionState, fzapTransportState, fzapConnectionTransport, assertExpectedFzapIdentity } from '../../src/lib/fzapConnections.js'

const TOKEN = 'ficticioTesteIsoladoSemProvedorReal_0123456789'
const base = { id: 'comercial', instanceName: 'vivenzza', nome: 'Comercial', finalidade: 'comercial', token: TOKEN }
const envFor = (connections = [base], url = 'https://fzap.vivenzzaprofessional.com.br') => ({ FZAP_API_URL: url, FZAP_WEBHOOK_SECRET: TOKEN, FZAP_CONNECTIONS_JSON: JSON.stringify(connections) })
const ok = (data) => ({ code: 200, success: true, data })
const requested = Object.freeze({ vivenzza_crm_migration_requested: true })
const providerMetadata = { vivenzza_crm_instance_name: 'vivenzza', vivenzza_crm_transport: 'fzap' }
const connected = { connected: true, loggedIn: true, jid: '5511000000000@s.whatsapp.net',
  metadata: { ...requested, ...providerMetadata, vivenzza_crm_expected_jid_sha256: createHash('sha256').update('5511000000000').digest('hex') } }
const waiting = { connected: true, loggedIn: false, metadata: requested }
const disconnected = { connected: false, loggedIn: false, metadata: requested }

function fakeStore({ owner = 'evolution', migrationRequested = true, instanceName = base.instanceName, finalidade = base.finalidade } = {}) {
  const row = { owner, migrationRequested, instanceName, finalidade }
  const calls = []
  return { row, calls, async get(id) { calls.push(['get', id]); return { ...row } },
    async request(id) { calls.push(['request', id]); if (row.owner === 'evolution') row.migrationRequested = true; return { ...row } },
    async complete(id) { calls.push(['complete', id]); if (row.owner === 'evolution' && row.migrationRequested) { row.owner = 'fzap'; row.migrationRequested = false }; return { ...row } } }
}
function createFzapConnectionsService(options = {}) {
  const config = options.env?.FZAP_CONNECTIONS_JSON ? JSON.parse(options.env.FZAP_CONNECTIONS_JSON) : []
  const stores = new Map(config.filter(Array.isArray(config) ? () => true : () => false).map((c) => [c.id, fakeStore(c)]))
  const ownershipStore = options.ownershipStore ?? Object.fromEntries(['get', 'request', 'complete'].map((method) => [method, (id) => stores.get(id)[method](id)]))
  return makeService({ ...options, ownershipStore })
}
function webhook(headers = { 'X-FZAP-Webhook-Token': fzapWebhookSecret(TOKEN, 'comercial') }, events = ['Message', 'ReadReceipt']) {
  return [{ url: 'https://vivenzza-crm-api-production.up.railway.app/api/whatsapp/fzap-webhook/comercial', headers, events }]
}

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='

test('QR aceita qrCode real da FZAP 1.36 e QRCode documentado sem alterar ownership', async () => {
  for (const payload of [{ qrCode: png }, { QRCode: png }, { QRCode: '', qrCode: png }, { QRCode: png, qrCode: png }]) {
    const store = fakeStore()
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store,
      transport: async ({ path }) => ok(path === '/session/qr' ? payload : waiting) })
    const result = await service.qr('comercial')
    assert.equal(result.qrcode, png)
    assert.equal(result.transporte_ativo, 'evolution')
    assert.deepEqual(store.calls, [['get', 'comercial']])
  }
})

test('QR rejeita aliases conflitantes e formato inválido no alias real', async () => {
  const otherPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const single = createFzapConnectionsService({ env: envFor(),
    transport: async ({ path }) => ok(path === '/session/qr' ? { qrCode: otherPng } : waiting) })
  assert.equal((await single.qr('comercial')).qrcode, otherPng, 'segundo PNG é aceito isoladamente')
  for (const payload of [{ qrCode: 'https://invalid.example/qr' }, { qrCode: false }, { QRCode: png, qrCode: otherPng }]) {
    const service = createFzapConnectionsService({ env: envFor(),
      transport: async ({ path }) => ok(path === '/session/qr' ? payload : waiting) })
    await assert.rejects(service.qr('comercial'), { code: 'UPSTREAM' })
  }
})

test('configuração ausente tem estado não configurado, sem chamar provedor', async () => {
  assert.equal(readFzapConfig({}), null)
  const service = createFzapConnectionsService({ env: {}, transport: () => assert.fail('provider called') })
  assert.deepEqual((await service.list()).conexoes, [])
  assert.equal((await service.list()).configurado, false)
  await assert.rejects(service.connect('comercial'), { code: 'CONFIG', status: 503 })
})

test('rejeita URLs arbitrárias, privadas, HTTP, credenciais, porta, path, query e fragmento', () => {
  for (const url of ['http://fzap.vivenzzaprofessional.com.br', 'https://127.0.0.1', 'https://169.254.169.254', 'https://example.com',
    'https://user:secret@fzap.vivenzzaprofessional.com.br', 'https://fzap.vivenzzaprofessional.com.br:8080',
    'https://fzap.vivenzzaprofessional.com.br/admin', 'https://fzap.vivenzzaprofessional.com.br?token=secret', 'https://fzap.vivenzzaprofessional.com.br/#x']) {
    assert.throws(() => readFzapConfig(envFor([base], url)), { code: 'CONFIG' })
  }
})

test('rejeita configuração incompleta, malformada, duplicada e mistura comercial no financeiro', () => {
  for (const env of [{ FZAP_API_URL: 'https://fzap.vivenzzaprofessional.com.br' }, { ...envFor(), FZAP_CONNECTIONS_JSON: '{' },
    envFor([base, base]), envFor([{ ...base, id: 123 }]), envFor([{ ...base, token: 'curto' }]),
    envFor([{ ...base, finalidade: 'financeiro' }]), envFor([{ ...base, instanceName: '../admin' }]),
    envFor([{ ...base, finalidade: 'qualquer' }]), envFor({}), envFor([{ ...base, token: TOKEN + '\n' }]),
    envFor([{ ...base, pareamentoHabilitado: 'false' }]), envFor([{ ...base, pareamentoHabilitado: null }])]) {
    assert.throws(() => readFzapConfig(env), { code: 'CONFIG' })
  }
  assert.equal(readFzapConfig(envFor()).connections[0].instanceName, 'vivenzza')
  assert.equal(readFzapConfig(envFor()).connections[0].pareamentoHabilitado, true)
  assert.equal(readFzapConfig(envFor([{ ...base, pareamentoHabilitado: false }])).connections[0].pareamentoHabilitado, false)
  assert.equal(readFzapConfig(envFor([{ ...base, instanceName: 'Mesagens Site Reativação' }])).connections[0].instanceName, 'Mesagens Site Reativação')
})

test('canal oficial bloqueado recusa connect, QR e conclusão antes de acessar DB ou FZAP', async () => {
  const service = createFzapConnectionsService({ env: envFor([{ ...base, instanceName: 'vivenzza-teste-cloud', pareamentoHabilitado: false }]),
    ownershipStore: { get: () => assert.fail('DB called'), request: () => assert.fail('DB called'), complete: () => assert.fail('DB called') },
    transport: () => assert.fail('provider called') })
  for (const method of ['connect', 'qr', 'complete']) {
    await assert.rejects(service[method]('comercial'), { code: 'PAIRING_DISABLED', status: 403,
      message: 'Conexão oficial preservada; pareamento por QR não preparado.' })
  }
})

test('listagem do canal oficial preservado expõe aviso e não gera sessão nem altera proprietário', async () => {
  const store = fakeStore({ instanceName: 'vivenzza-teste-cloud', migrationRequested: false })
  const transportCalls = []
  const service = createFzapConnectionsService({ env: envFor([{ ...base, instanceName: 'vivenzza-teste-cloud', pareamentoHabilitado: false }]),
    ownershipStore: store, transport: async (req) => {
      transportCalls.push([req.method, req.path])
      return ok(disconnected)
    } })
  const row = (await service.list()).conexoes[0]
  assert.deepEqual(transportCalls, [['GET', '/session/status']])
  assert.equal(row.pareamento_habilitado, false)
  assert.equal(row.aviso, 'Conexão oficial preservada; pareamento por QR não preparado.')
  assert.equal(row.transporte_ativo, 'evolution')
  assert.equal(store.calls.some(([method]) => method !== 'get'), false)
  assert.equal(store.row.owner, 'evolution')
})

test('estado requer booleanos exatos e distingue websocket de login WhatsApp', () => {
  assert.equal(fzapSessionState(connected), 'conectado')
  assert.equal(fzapSessionState(waiting), 'conectando')
  assert.equal(fzapSessionState(disconnected), 'desconectado')
  assert.equal(fzapSessionState({ connected: false, loggedIn: true }), 'desconectado')
  for (const data of [null, {}, { connected: 'true', loggedIn: 'true' }, { connected: true }]) assert.equal(fzapSessionState(data), 'indeterminado')
})

test('listagem separa canais e retém somente DTO permitido, sem token ou metadados privados', async () => {
  const connections = [base, { ...base, id: 'financeiro', instanceName: 'vivenzza-financeiro', nome: 'Financeiro', finalidade: 'financeiro', token: TOKEN + '2' }]
  const calls = []
  const service = createFzapConnectionsService({ env: envFor(connections), transport: async (req) => {
    calls.push(req)
    return ok({ ...connected, token: req.token, s3Config: { secret: 'private' }, jid: 'numero-privado', qrCode: png })
  } })
  const result = await service.list()
  assert.equal(result.conexoes[1].finalidade, 'financeiro')
  assert.equal(result.conexoes[0].conectado, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].path, '/session/status')
  for (const secret of [TOKEN, 'numero-privado', png, 'private', 's3Config']) assert.equal(JSON.stringify(result).includes(secret), false)
})

test('falha de um canal é indeterminada, sem inventar offline ou esconder o outro', async () => {
  const service = createFzapConnectionsService({ env: envFor([base, { ...base, id: 'outro', instanceName: 'outro', token: TOKEN + '2' }]),
    transport: async ({ token }) => { if (token === TOKEN) throw new Error(TOKEN); return ok(connected) } })
  const result = await service.list()
  assert.equal(result.conexoes[0].estado, 'indeterminado')
  assert.equal(result.conexoes[1].estado, 'conectado')
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('id fora da allowlist nunca chega à FZAP', async () => {
  const service = createFzapConnectionsService({ env: envFor(), transport: () => assert.fail('provider called') })
  await assert.rejects(service.connect('../admin'), { code: 'NOT_FOUND', status: 404 })
  await assert.rejects(service.qr('nao-cadastrado'), { code: 'NOT_FOUND', status: 404 })
})

test('conexão já pareada não é reiniciada, não consulta QR nem faz POST', async () => {
  const calls = []
  const service = createFzapConnectionsService({ env: envFor(), transport: async (r) => { calls.push(r); return ok(connected) } })
  assert.deepEqual(await service.connect('comercial'), { estado: 'conectado', transporte_ativo: 'evolution', qrcode: null, expira_em: null })
  assert.deepEqual(calls.map((r) => r.path), ['/session/status'])
})

test('conexão aguardando QR não repete POST; QR assíncrono vazio é honesto', async () => {
  const calls = []
  const service = createFzapConnectionsService({ env: envFor(), transport: async (r) => { calls.push(r); return ok(r.path === '/session/qr' ? { QRCode: '' } : waiting) } })
  assert.deepEqual(await service.connect('comercial'), { estado: 'conectando', transporte_ativo: 'evolution', qrcode: null, expira_em: null })
  assert.equal(calls.some((r) => r.method === 'POST'), false)
})

test('inicia sessão com immediate true e depois lê QR, sem vazar a resposta inteira', async () => {
  const calls = []
  const service = createFzapConnectionsService({ env: envFor(), now: () => 1000, transport: async (r) => {
    calls.push(r)
    if (calls.length === 1) return ok(disconnected)
    return ok(r.path === '/session/qr' ? { QRCode: png, token: TOKEN } : waiting)
  } })
  const result = await service.connect('comercial')
  assert.deepEqual(calls.map((r) => `${r.method} ${r.path}`), ['GET /session/status', 'POST /session/connect', 'GET /session/status', 'GET /session/qr', 'GET /session/status'])
  assert.deepEqual(calls[1].body, { immediate: true })
  assert.equal(result.qrcode, png)
  assert.equal(result.expira_em, new Date(31000).toISOString())
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('leituras repetidas não prorrogam o mesmo QR; nova imagem ganha prazo curto', async () => {
  let time = 1000
  let qr = png
  const service = createFzapConnectionsService({ env: envFor(), now: () => time, transport: async ({ path }) => ok(path === '/session/qr' ? { QRCode: qr } : waiting) })
  assert.equal((await service.qr('comercial')).expira_em, new Date(31000).toISOString())
  time = 20000
  assert.equal((await service.qr('comercial')).expira_em, new Date(31000).toISOString())
  time = 31000
  assert.equal((await service.qr('comercial')).qrcode, null)
  qr = png.replace('AAAAASUVORK5CYII=', 'AAAAASUVORK5CYIA=')
  assert.equal((await service.qr('comercial')).expira_em, new Date(61000).toISOString())
})

test('descarta QR se pareamento ocorreu entre as consultas e não retorna QR de sessão desconectada', async () => {
  let statuses = 0
  const service = createFzapConnectionsService({ env: envFor(), transport: async ({ path }) => ok(path === '/session/qr' ? { QRCode: png } : ++statuses === 1 ? waiting : connected) })
  assert.deepEqual(await service.qr('comercial'), { estado: 'conectado', transporte_ativo: 'evolution', qrcode: null, expira_em: null })
  const disconnectedService = createFzapConnectionsService({ env: envFor(), transport: async ({ path }) => { assert.equal(path, '/session/status'); return ok(disconnected) } })
  assert.equal((await disconnectedService.qr('comercial')).qrcode, null)
})

test('rejeita QR remoto, SVG, base64 inválido, PNG falso e payload excessivo', async () => {
  for (const qr of ['https://example.com/qr.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,????', 'data:image/png;base64,YWFhYWFhYWFhYWFh', png + 'A'.repeat(400000)]) {
    const service = createFzapConnectionsService({ env: envFor(), transport: async ({ path }) => ok(path === '/session/qr' ? { QRCode: qr } : waiting) })
    await assert.rejects(service.qr('comercial'), { code: 'UPSTREAM', status: 503 })
  }
})

test('duplo clique simultâneo compartilha a operação sem duplicar POST', async () => {
  let posts = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const service = createFzapConnectionsService({ env: envFor(), transport: async ({ method, path }) => {
    if (method === 'POST') { posts++; await gate; return ok(waiting) }
    return ok(path === '/session/qr' ? { QRCode: '' } : disconnected)
  } })
  const first = service.connect('comercial')
  const second = service.connect('comercial')
  assert.strictEqual(first, second)
  release()
  await Promise.all([first, second])
  assert.equal(posts, 1)
})

test('erro de POST ambíguo não é repetido e mensagem de erro nunca inclui token', async () => {
  let posts = 0
  const service = createFzapConnectionsService({ env: envFor(), transport: async ({ method }) => {
    if (method === 'POST') { posts++; throw new Error(`timeout ${TOKEN}`) }
    return ok(disconnected)
  } })
  await assert.rejects(service.connect('comercial'), (error) => error.status === 503 && !JSON.stringify(error).includes(TOKEN) && !error.message.includes(TOKEN))
  assert.equal(posts, 1)
})

test('timeout limita inclusive transportes injetados que ignoram AbortSignal', async () => {
  let signal
  const service = createFzapConnectionsService({ env: envFor(), timeoutMs: 20, transport: (r) => { signal = r.signal; return new Promise(() => {}) } })
  await assert.rejects(service.connect('comercial'), { status: 503 })
  assert.equal(signal.aborted, true)
})

test('envelope inválido ou status desconhecido não dispara conexão automaticamente', async () => {
  for (const response of [{ success: false, code: 200, data: disconnected }, { success: true, code: 500, data: disconnected }, ok({ connected: 'true', loggedIn: 'false' })]) {
    const transportCalls = []
    const service = createFzapConnectionsService({ env: envFor(), transport: async ({ method, path }) => { transportCalls.push([method, path]); return response } })
    await assert.rejects(service.connect('comercial'), { status: 503 })
    assert.deepEqual(transportCalls, [['GET', '/session/status']])
  }
})

test('transporte padrão usa somente header token, proíbe redirect e limita bytes recebidos', async () => {
  const previous = globalThis.fetch
  try {
    let observed
    globalThis.fetch = async (url, options) => { observed = { url, options }; return new Response(JSON.stringify(ok(connected)), { status: 200 }) }
    assert.equal((await fzapConnectionTransport({ baseURL: 'https://fzap.vivenzzaprofessional.com.br', path: '/session/status', method: 'GET', token: TOKEN })).success, true)
    assert.equal(observed.url.href.includes(TOKEN), false)
    assert.equal(observed.options.headers.token, TOKEN)
    assert.equal(observed.options.redirect, 'error')
    globalThis.fetch = async () => new Response('x'.repeat(512 * 1024 + 1), { status: 200 })
    await assert.rejects(fzapConnectionTransport({ baseURL: 'https://fzap.vivenzzaprofessional.com.br', path: '/session/status', method: 'GET', token: TOKEN }), { status: 503 })
  } finally { globalThis.fetch = previous }
})

test('metadata ausente nunca define proprietário; listagem usa somente decisão durável do CRM', async () => {
  assert.equal(fzapTransportState({}), 'indeterminado')
  assert.equal(fzapTransportState({ metadata: { vivenzza_crm_transport: 'evolution' } }), 'indeterminado')
  const store = fakeStore({ owner: 'fzap', migrationRequested: false })
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async () => ok({ ...connected, metadata: {} }) })
  assert.equal((await service.list()).conexoes[0].transporte_ativo, 'fzap')
  assert.equal((await service.qr('comercial')).transporte_ativo, 'fzap')
  assert.equal(store.calls.some(([method]) => method !== 'get'), false)
})

test('intenção é gravada no CRM antes de connect; resposta assíncrona sem booleanos é relida', async () => {
  const store = fakeStore({ migrationRequested: false })
  const calls = []
  let started = false
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
    calls.push([req.method, req.path])
    if (req.path === '/session/connect') {
      assert.equal(store.row.migrationRequested, true)
      started = true
      return ok({ message: 'Connection started' })
    }
    return ok(req.path === '/session/qr' ? { QRCode: '' } : started ? waiting : disconnected)
  } })
  assert.equal((await service.connect('comercial')).estado, 'conectando')
  assert.deepEqual(calls, [['GET', '/session/status'], ['POST', '/session/connect'], ['GET', '/session/status'], ['GET', '/session/qr']])
  assert.equal(store.calls.filter(([m]) => m === 'request').length, 1)
  assert.equal(calls.some(([m]) => m === 'PATCH'), false)
})

test('concluir exige intenção CRM, pareamento e referência ou autorização explícita de primeiro pareamento', async () => {
  for (const scenario of [
    { intent: false, data: connected, code: 'INTENT' },
    { intent: true, data: waiting, code: 'PAIRING' },
    { intent: true, data: { ...connected, metadata: {} }, code: 'IDENTITY_REQUIRED' },
    { intent: true, data: { ...connected, metadata: { vivenzza_crm_first_pairing_authorized: 'true' } }, code: 'IDENTITY_REQUIRED' },
  ]) {
    const store = fakeStore({ migrationRequested: scenario.intent })
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async () => ok(scenario.data) })
    await assert.rejects(service.complete('comercial'), { code: scenario.code, status: 409 })
    assert.equal(store.row.owner, 'evolution')
    assert.equal(store.calls.some(([m]) => m === 'complete'), false)
  }
})

test('identidade divergente bloqueia CAS e não expõe telefone ou hash', async () => {
  const digest = createHash('sha256').update('5511000000000').digest('hex')
  for (const jid of ['5511000000001@s.whatsapp.net', '+5511000000000@s.whatsapp.net', '', null]) {
    const store = fakeStore()
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async () => ok({ ...connected, jid, metadata: { vivenzza_crm_expected_jid_sha256: digest } }) })
    await assert.rejects(service.complete('comercial'), (error) => error.code === 'IDENTITY' && error.status === 409 && !error.message.includes(digest) && !error.message.includes('5511000000000'))
    assert.equal(store.row.owner, 'evolution')
  }
})

test('webhook deve ter URL exata, token secreto e eventos Message e ReadReceipt antes do CAS', async () => {
  for (const hooks of [[], webhook({}, ['Message', 'ReadReceipt']), webhook({ 'X-FZAP-Webhook-Token': 'incorreto' }),
    webhook({ 'X-FZAP-Webhook-Token': TOKEN }), webhook({ 'X-FZAP-Webhook-Token': fzapWebhookSecret(TOKEN, 'financeiro') }), webhook(undefined, ['Message']),
    [{ ...webhook()[0], url: webhook()[0].url + '?token=segredo' }], [...webhook(), ...webhook()]]) {
    const store = fakeStore()
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async ({ path }) => ok(path === '/webhook' ? hooks : connected) })
    await assert.rejects(service.complete('comercial'), { code: 'WEBHOOK', status: 409 })
    assert.equal(store.row.owner, 'evolution')
    assert.equal(store.calls.some(([m]) => m === 'complete'), false)
  }
})

test('conclusão valida webhook e identidade, faz CAS CRM, readback e segue idempotente', async () => {
  const digest = createHash('sha256').update('5511000000000').digest('hex')
  const data = { ...connected, jid: '5511000000000:4@s.whatsapp.net', metadata: { ...providerMetadata, vivenzza_crm_expected_jid_sha256: digest } }
  const store = fakeStore()
  const calls = []
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
    calls.push(req)
    assert.equal(req.method, 'GET')
    return ok(req.path === '/webhook' ? webhook() : data)
  } })
  const result = await service.complete('comercial')
  assert.equal(result.transporte_ativo, 'fzap')
  assert.equal(store.row.migrationRequested, false)
  assert.equal(store.calls.filter(([m]) => m === 'complete').length, 1)
  assert.equal(JSON.stringify(result).includes(digest), false)
  assert.equal((await service.complete('comercial')).transporte_ativo, 'fzap')
  assert.equal(store.calls.filter(([m]) => m === 'complete').length, 1)
  assert.deepEqual(calls.slice(0, 3).map(({ path }) => path), ['/session/status', '/webhook', '/session/status'])
})

test('queda ou troca de telefone durante verificação do webhook bloqueia alteração durável', async () => {
  for (const after of [disconnected, { ...connected, metadata: {} }]) {
    let count = 0
    const store = fakeStore()
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async ({ path }) => ok(path === '/webhook' ? webhook() : ++count === 1 ? connected : after) })
    await assert.rejects(service.complete('comercial'), { status: 409 })
    assert.equal(store.row.owner, 'evolution')
  }
})

test('metadados exigidos pelo transporte devem existir antes e imediatamente após a validação do webhook', async () => {
  for (const changedAfterWebhook of [false, true]) {
    for (const patch of [{ vivenzza_crm_instance_name: undefined }, { vivenzza_crm_instance_name: 'outro-canal' },
      { vivenzza_crm_transport: undefined }, { vivenzza_crm_transport: 'desconhecido' }]) {
      let statuses = 0
      const store = fakeStore()
      const invalid = { ...connected, metadata: { ...connected.metadata, ...patch } }
      const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async ({ path }) => {
        if (path === '/webhook') return ok(webhook())
        statuses++
        return ok(changedAfterWebhook && statuses === 1 ? connected : invalid)
      } })
      await assert.rejects(service.complete('comercial'), { status: 503 })
      assert.equal(store.row.owner, 'evolution')
      assert.equal(store.calls.some(([method]) => method === 'complete'), false)
    }
  }
})

test('fluxo integrado parte de metadata Evolution, registra intenção, prepara FZAP e só então promove owner CRM', async () => {
  const store = fakeStore({ migrationRequested: false })
  const digest = createHash('sha256').update('5511000000000').digest('hex')
  let metadata = { ...providerMetadata, vivenzza_crm_transport: 'evolution',
    vivenzza_crm_expected_jid_sha256: digest, configuracao: { legado: { ativo: true } }, extra: 'preservado' }
  const calls = []
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
    calls.push(req)
    if (req.path === '/session/metadata') {
      assert.equal(req.method, 'PATCH')
      assert.equal(store.row.owner, 'evolution')
      assert.equal(store.row.migrationRequested, true)
      metadata = structuredClone(req.body.metadata)
      return ok({ metadata })
    }
    assert.equal(req.method, 'GET')
    return ok(req.path === '/webhook' ? webhook() : { ...connected, jid: '5511000000000:7@s.whatsapp.net', metadata })
  } })
  assert.equal((await service.connect('comercial')).transporte_ativo, 'evolution')
  assert.equal(store.row.migrationRequested, true)
  assert.equal(metadata.vivenzza_crm_transport, 'evolution')
  const result = await service.complete('comercial')
  assert.equal(result.transporte_ativo, 'fzap')
  assert.equal(store.row.owner, 'fzap')
  assert.equal(store.row.migrationRequested, false)
  assert.equal(metadata.vivenzza_crm_expected_jid_sha256, digest)
  assert.equal(metadata.extra, 'preservado')
  assert.deepEqual(metadata.configuracao, { legado: { ativo: true } })
  assert.equal(calls.filter(({ method }) => method === 'POST').length, 0)
  assert.equal(calls.filter(({ method }) => method === 'PATCH').length, 1)
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
  assert.equal(JSON.stringify(result).includes(digest), false)
  assert.equal(JSON.stringify(result).includes('5511000000000'), false)
})

test('falha de PATCH/readback não promove owner e não repete mutação ambígua', async () => {
  for (const failure of ['timeout', 'divergente', 'desconectado']) {
    const store = fakeStore()
    let metadata = { ...connected.metadata, vivenzza_crm_transport: 'evolution' }
    let patches = 0
    const ownersAtPatch = []
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
      if (req.method === 'PATCH') {
        patches++
        ownersAtPatch.push(store.row.owner)
        if (failure === 'timeout') throw new Error(TOKEN)
        if (failure !== 'divergente') metadata = req.body.metadata
        return ok({ metadata })
      }
      return ok(req.path === '/webhook' ? webhook() : { ...(patches && failure === 'desconectado' ? disconnected : connected), metadata })
    } })
    await assert.rejects(service.complete('comercial'), { status: failure === 'desconectado' ? 409 : 503 })
    assert.equal(patches, 1)
    assert.deepEqual(ownersAtPatch, ['evolution'])
    assert.equal(store.row.owner, 'evolution')
    assert.equal(store.calls.some(([method]) => method === 'complete'), false)
  }
})

test('owner CRM já FZAP com metadata Evolution falha sem reparar provider automaticamente', async () => {
  const store = fakeStore({ owner: 'fzap', migrationRequested: false })
  const transportCalls = []
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
    transportCalls.push([req.method, req.path])
    return ok({ ...connected, metadata: { ...connected.metadata, vivenzza_crm_transport: 'evolution' } })
  } })
  await assert.rejects(service.complete('comercial'), { status: 503 })
  assert.deepEqual(transportCalls, [['GET', '/session/status']])
  assert.equal(store.calls.some(([method]) => method === 'complete'), false)
})

test('primeiro pareamento autorizado fixa hash, consome permissão e confirma identidade antes de promover CRM', async () => {
  const store = fakeStore()
  let metadata = { ...providerMetadata, vivenzza_crm_transport: 'evolution', vivenzza_crm_first_pairing_authorized: true, legado: { preservado: true } }
  let jid = '5511000000000:3@s.whatsapp.net'
  let patches = 0
  const expected = createHash('sha256').update('5511000000000').digest('hex')
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
    if (req.method === 'PATCH') {
      assert.equal(store.row.owner, 'evolution')
      patches++
      metadata = structuredClone(req.body.metadata)
      assert.equal(metadata.vivenzza_crm_expected_jid_sha256, expected)
      assert.equal(metadata.vivenzza_crm_first_pairing_authorized, false)
      return ok({ metadata })
    }
    return ok(req.path === '/webhook' ? webhook() : { ...connected, jid, metadata })
  } })
  const result = await service.complete('comercial')
  assert.equal(result.transporte_ativo, 'fzap')
  assert.equal(patches, 1)
  assert.equal(metadata.legado.preservado, true)
  assert.equal(JSON.stringify(result).includes(expected), false)
  assert.equal(JSON.stringify(result).includes('5511000000000'), false)
  // A later phone change cannot reuse the consumed first-pairing permission.
  jid = '5511000000001@s.whatsapp.net'
  await assert.rejects(service.complete('comercial'), { code: 'IDENTITY', status: 409 })
  assert.equal(patches, 1)
})

test('resolver estrito exige hash mesmo com permissão inicial e rejeita referência malformada', () => {
  assert.throws(() => assertExpectedFzapIdentity({ ...connected, metadata: { vivenzza_crm_first_pairing_authorized: true } }), { code: 'IDENTITY_REQUIRED' })
  assert.throws(() => assertExpectedFzapIdentity({ ...connected, metadata: { vivenzza_crm_expected_jid_sha256: 'inválido' } }), { code: 'UPSTREAM' })
  assert.doesNotThrow(() => assertExpectedFzapIdentity(connected))
})

test('troca de telefone durante fixação do primeiro hash bloqueia promoção CRM', async () => {
  const store = fakeStore()
  let metadata = { ...providerMetadata, vivenzza_crm_transport: 'evolution', vivenzza_crm_first_pairing_authorized: true }
  let patched = false
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
    if (req.method === 'PATCH') { metadata = req.body.metadata; patched = true; return ok({ metadata }) }
    return ok(req.path === '/webhook' ? webhook() : { ...connected,
      jid: patched ? '5511000000001@s.whatsapp.net' : '5511000000000@s.whatsapp.net', metadata })
  } })
  await assert.rejects(service.complete('comercial'), { code: 'IDENTITY', status: 409 })
  assert.equal(store.row.owner, 'evolution')
  assert.equal(store.calls.some(([method]) => method === 'complete'), false)
})

test('falha de DB, identidade de linha trocada ou intenção não persistida falham fechadas', async () => {
  for (const store of [
    { get: async () => { throw new Error(TOKEN) } },
    fakeStore({ instanceName: 'outro-canal' }), fakeStore({ finalidade: 'financeiro' }),
    { ...fakeStore({ migrationRequested: false }), request: async () => ({ owner: 'evolution', migrationRequested: false }) },
  ]) {
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async () => ok(connected) })
    await assert.rejects(service.connect('comercial'), (error) => error.status === 503 && !error.message.includes(TOKEN))
  }
})

test('CAS recusado ou readback sem proprietário FZAP não retorna conclusão', async () => {
  for (const readbackFailure of [false, true]) {
    const store = fakeStore()
    store.complete = async () => readbackFailure ? { owner: 'fzap', migrationRequested: false } : { owner: 'evolution', migrationRequested: true }
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async ({ path }) => ok(path === '/webhook' ? webhook() : connected) })
    await assert.rejects(service.complete('comercial'), { status: 503 })
    assert.equal(store.row.owner, 'evolution')
  }
})

test('DB travado respeita prazo total e não chama provedor após timeout', async () => {
  let release, providerCalls = 0
  const stalled = new Promise(resolve => { release = resolve })
  const service = createFzapConnectionsService({ env: envFor(), timeoutMs: 20,
    ownershipStore: { get: () => stalled }, transport: () => { providerCalls++; return ok(disconnected) } })
  await assert.rejects(service.connect('comercial'), { status: 503 })
  release(fakeStore().row)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(providerCalls, 0)
})

test('falha FZAP conserva proprietário CRM conhecido e não sugere retorno à Evolution', async () => {
  const store = fakeStore({ owner: 'fzap', migrationRequested: false })
  const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async () => { throw new Error(TOKEN) } })
  const row = (await service.list()).conexoes[0]
  assert.equal(row.estado, 'indeterminado')
  assert.equal(row.transporte_ativo, 'fzap')
})

test('status de conexão já migrada não fica verde com telefone errado ou metadados ausentes', async () => {
  for (const data of [{ ...connected, jid: '5511000000001@s.whatsapp.net', token: TOKEN },
    { ...connected, metadata: {} }, { ...connected, metadata: { ...connected.metadata, vivenzza_crm_instance_name: 'outro' } },
    { ...connected, metadata: { ...connected.metadata, vivenzza_crm_transport: 'evolution' } }]) {
    const store = fakeStore({ owner: 'fzap', migrationRequested: false })
    const transportCalls = []
    const service = createFzapConnectionsService({ env: envFor(), ownershipStore: store, transport: async (req) => {
      transportCalls.push([req.method, req.path])
      return ok(data)
    } })
    const result = (await service.list()).conexoes[0]
    assert.deepEqual(transportCalls, [['GET', '/session/status']])
    assert.equal(result.estado, 'indeterminado')
    assert.equal(result.conectado, false)
    assert.equal(result.transporte_ativo, 'fzap')
    assert.equal(JSON.stringify(result).includes(TOKEN), false)
    assert.equal(JSON.stringify(result).includes('5511000000001'), false)
    assert.equal(store.calls.some(([method]) => method !== 'get'), false)
  }
})

test('status Evolution ainda sem pareamento não exige hash ou metadados da FZAP', async () => {
  const service = createFzapConnectionsService({ env: envFor(), transport: async () => ok({ connected: false, loggedIn: false }) })
  const row = (await service.list()).conexoes[0]
  assert.equal(row.estado, 'desconectado')
  assert.equal(row.transporte_ativo, 'evolution')
})

test('operação concorrente diferente é recusada sem enfileirar mutação', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const service = createFzapConnectionsService({ env: envFor(), transport: async () => { await gate; return ok(connected) } })
  const pending = service.connect('comercial')
  await assert.rejects(service.complete('comercial'), { code: 'BUSY', status: 409 })
  release()
  await pending
})
