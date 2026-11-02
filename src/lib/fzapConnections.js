import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { fzapWebhookSecret } from './fzapWebhookSecret.js'

const FZAP_HOST = 'fzap.vivenzzaprofessional.com.br'
const QR_PREFIX = 'data:image/png;base64,'
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const QR_TTL_MS = 30_000
const CRM_API_ORIGIN = 'https://vivenzza-crm-api-production.up.railway.app'

export class FzapConnectionError extends Error {
  constructor(code, status = 503) {
    super(code === 'NOT_FOUND' ? 'Conexão não encontrada.' : code === 'BUSY' ? 'Esta conexão já está sendo preparada. Aguarde a operação atual.'
      : code === 'PAIRING_DISABLED' ? 'Conexão oficial preservada; pareamento por QR não preparado.'
      : code === 'INTENT' ? 'Gere o QR code desta conexão antes de concluir a migração.'
      : code === 'IDENTITY' ? 'O telefone pareado não corresponde à conexão de origem.'
      : code === 'IDENTITY_REQUIRED' ? 'A identidade de origem ou autorização de primeiro pareamento precisa ser configurada no servidor.'
      : code === 'WEBHOOK' ? 'O recebimento de mensagens desta conexão precisa ser configurado no servidor antes da migração.'
      : code === 'PAIRING' ? 'Leia o QR code no telefone antes de concluir a migração.' : code === 'CONFIG'
      ? 'A configuração das conexões WhatsApp precisa ser concluída no servidor.'
      : 'Não foi possível consultar a FZAP. Tente novamente em instantes.')
    this.name = 'FzapConnectionError'
    this.code = code
    this.status = status
  }
}

export function readFzapConfig(env = process.env) {
  const url = env.FZAP_API_URL
  const raw = env.FZAP_CONNECTIONS_JSON
  if (!url && !raw) return null
  try {
    if (typeof url !== 'string' || typeof raw !== 'string') throw new Error()
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== FZAP_HOST
      || (parsed.port && parsed.port !== '443') || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error()
    const connections = JSON.parse(raw)
    if (!Array.isArray(connections) || connections.length > 16) throw new Error()
    const ids = new Set(), names = new Set(), tokens = new Set()
    const clean = connections.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.id)
        || typeof item.instanceName !== 'string' || !item.instanceName.trim() || item.instanceName.length > 100 || /[\u0000-\u001f\u007f-\u009f/\\]/.test(item.instanceName)
        || typeof item.nome !== 'string' || item.nome.trim().length < 1 || item.nome.length > 100
        || !['comercial', 'financeiro', 'notificacoes'].includes(item.finalidade)
        || typeof item.token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(item.token)
        || (item.pareamentoHabilitado !== undefined && typeof item.pareamentoHabilitado !== 'boolean')
        || ids.has(item.id) || names.has(item.instanceName) || tokens.has(item.token)) throw new Error()
      if (item.finalidade === 'financeiro' && ['vivenzza', 'vivenzza-teste-cloud'].includes(item.instanceName)) throw new Error()
      ids.add(item.id); names.add(item.instanceName); tokens.add(item.token)
      return { id: item.id, instanceName: item.instanceName, nome: item.nome.trim(), finalidade: item.finalidade, token: item.token,
        pareamentoHabilitado: item.pareamentoHabilitado !== false }
    })
    return { baseURL: parsed.origin, connections: clean }
  } catch {
    throw new FzapConnectionError('CONFIG')
  }
}

// Deliberately exposes no raw request/response or axios error containing tokens.
export async function fzapConnectionTransport({ baseURL, path, method, token, body, signal }) {
  const response = await fetch(new URL(path, baseURL), {
    method, signal, redirect: 'error',
    headers: { token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new FzapConnectionError('UPSTREAM')
  // The QR payload is small. Bound response bytes even when Content-Length is absent.
  const reader = response.body?.getReader()
  if (!reader) throw new FzapConnectionError('UPSTREAM')
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > 512 * 1024) throw new FzapConnectionError('UPSTREAM')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}

export function fzapSessionState(data) {
  if (!data || typeof data.connected !== 'boolean' || typeof data.loggedIn !== 'boolean') return 'indeterminado'
  if (!data.connected) return 'desconectado'
  return data.loggedIn ? 'conectado' : 'conectando'
}

export function fzapTransportState(data) {
  const owner = data?.owner
  if (owner === 'fzap') return 'fzap'
  if (owner === 'evolution') return 'evolution'
  return 'indeterminado'
}

function metadataObject(data) {
  const metadata = data?.metadata
  if (metadata == null) return {}
  if (typeof metadata !== 'object' || Array.isArray(metadata)) throw new FzapConnectionError('UPSTREAM')
  return metadata
}

function canonicalIdentity(data) {
  const canonical = typeof data?.jid === 'string' ? data.jid.split('@')[0].split(':')[0] : ''
  if (!/^[0-9]+$/.test(canonical)) throw new FzapConnectionError('IDENTITY', 409)
  return canonical
}

// The provider resolver uses this strict form after ownership has migrated.
// A first-pairing permission is never a lasting substitute for a pinned identity.
export function assertExpectedFzapIdentity(data) {
  const expected = metadataObject(data).vivenzza_crm_expected_jid_sha256
  if (expected == null) throw new FzapConnectionError('IDENTITY_REQUIRED', 409)
  if (typeof expected !== 'string' || !/^[a-fA-F0-9]{64}$/.test(expected)) throw new FzapConnectionError('UPSTREAM')
  if (createHash('sha256').update(canonicalIdentity(data)).digest('hex') !== expected.toLowerCase()) throw new FzapConnectionError('IDENTITY', 409)
}

function assertPairingIdentity(data, allowFirstPairing) {
  if (metadataObject(data).vivenzza_crm_expected_jid_sha256 == null && allowFirstPairing
    && metadataObject(data).vivenzza_crm_first_pairing_authorized === true) {
    canonicalIdentity(data)
    return
  }
  assertExpectedFzapIdentity(data)
}

function assertProviderMetadata(data, connection, allowEvolution = false) {
  const metadata = metadataObject(data)
  if (metadata.vivenzza_crm_instance_name !== connection.instanceName
    || !(allowEvolution ? ['evolution', 'fzap'] : ['fzap']).includes(metadata.vivenzza_crm_transport)) throw new FzapConnectionError('UPSTREAM')
}

function checkedMetadata(metadata) {
  const walk = (value, level) => {
    if (!value || typeof value !== 'object') return
    if (level > 3) throw new FzapConnectionError('UPSTREAM')
    for (const nested of Object.values(value)) walk(nested, level + 1)
  }
  walk(metadata, 1)
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 16 * 1024) throw new FzapConnectionError('UPSTREAM')
  return metadata
}

function responseData(response, allowArray = false) {
  if (!response || response.success !== true || !Number.isInteger(response.code)
    || response.code < 200 || response.code > 299 || !response.data || typeof response.data !== 'object'
    || (!allowArray && Array.isArray(response.data))) throw new FzapConnectionError('UPSTREAM')
  return response.data
}

function validPngQr(value) {
  if (typeof value !== 'string' || !value.startsWith(QR_PREFIX) || value.length > 384 * 1024) return false
  const base64 = value.slice(QR_PREFIX.length)
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return false
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length > PNG_SIGNATURE.length && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
}

export function createFzapConnectionsService({
  env = process.env, getConfig = () => readFzapConfig(env), transport = fzapConnectionTransport,
  timeoutMs = 10_000, now = () => Date.now(), ownershipStore,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('Invalid timeout')
  const mutating = new Map()
  const seenQr = new Map()

  async function call(config, connection, method, path, body, deadline = performance.now() + timeoutMs) {
    const remaining = Math.ceil(deadline - performance.now())
    if (remaining < 1) throw new FzapConnectionError('UPSTREAM')
    const controller = new AbortController()
    let timer
    try {
      return responseData(await Promise.race([
        Promise.resolve().then(() => transport({ baseURL: config.baseURL, method, path, token: connection.token, body, signal: controller.signal })),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new FzapConnectionError('TIMEOUT')) }, remaining)
        }),
      ]), path === '/webhook')
    } catch {
      throw new FzapConnectionError('UPSTREAM')
    } finally {
      clearTimeout(timer)
    }
  }

  function find(id) {
    const config = getConfig()
    if (!config) throw new FzapConnectionError('CONFIG')
    const connection = config.connections.find((item) => item.id === id)
    if (!connection) throw new FzapConnectionError('NOT_FOUND', 404)
    if (connection.pareamentoHabilitado === false) throw new FzapConnectionError('PAIRING_DISABLED', 403)
    return { config, connection }
  }

  async function session(config, connection, deadline) {
    return call(config, connection, 'GET', '/session/status', undefined, deadline)
  }

  async function ownership(connection, method = 'get', deadline = performance.now() + timeoutMs) {
    let timer
    try {
      const remaining = Math.ceil(deadline - performance.now())
      if (remaining < 1) throw new Error()
      const row = await Promise.race([
        Promise.resolve().then(async () => {
          ownershipStore ??= (await import('./whatsappOwnershipStore.js')).ownershipStore
          // Every mutation is preceded by a configuration/row identity check.
          const existing = await ownershipStore.get(connection.id)
          if (fzapTransportState(existing) === 'indeterminado' || existing.instanceName !== connection.instanceName
            || existing.finalidade !== connection.finalidade) throw new Error()
          if (performance.now() >= deadline) throw new Error()
          return method === 'get' ? existing : ownershipStore[method](connection.id)
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error()), remaining) }),
      ])
      if (fzapTransportState(row) === 'indeterminado' || typeof row.migrationRequested !== 'boolean') throw new Error()
      return row
    } catch { throw new FzapConnectionError('UPSTREAM') }
    finally { clearTimeout(timer) }
  }

  function emptyQr(data, owner) { return { estado: fzapSessionState(data), transporte_ativo: fzapTransportState(owner), qrcode: null, expira_em: null } }

  async function qrFor(config, connection, data, deadline, owner) {
    const estado = fzapSessionState(data)
    if (estado !== 'conectando') {
      seenQr.delete(connection.id)
      return emptyQr(data, owner)
    }
    const qrData = await call(config, connection, 'GET', '/session/qr', undefined, deadline)
    // v1.36 returns qrCode; the published OpenAPI specifies QRCode.
    // Reject conflicting aliases instead of selecting an ambiguous credential.
    const images = [qrData.qrCode, qrData.QRCode].filter((value) => value != null && value !== '')
    if (!images.length) return emptyQr(data, owner)
    const qrImage = images[0]
    if (images.some((value) => !validPngQr(value) || value !== qrImage)) throw new FzapConnectionError('UPSTREAM')
    const digest = createHash('sha256').update(qrImage).digest('hex')
    let observed = seenQr.get(connection.id)
    if (!observed || observed.digest !== digest) {
      observed = { digest, expiresAt: now() + QR_TTL_MS }
      seenQr.set(connection.id, observed)
    }
    // Repeated polling never extends the same QR's display deadline.
    if (observed.expiresAt <= now()) return emptyQr(data, owner)
    // Confirm the scan did not complete between status and QR reads.
    const confirmed = await session(config, connection, deadline)
    if (fzapSessionState(confirmed) !== 'conectando') {
      seenQr.delete(connection.id)
      return emptyQr(confirmed, owner)
    }
    return { estado, transporte_ativo: fzapTransportState(owner), qrcode: qrImage, expira_em: new Date(observed.expiresAt).toISOString() }
  }

  async function assertWebhook(config, connection, deadline) {
    let secret
    try { secret = fzapWebhookSecret(env.FZAP_WEBHOOK_SECRET, connection.id) }
    catch { throw new FzapConnectionError('CONFIG') }
    if (!secret) throw new FzapConnectionError('CONFIG')
    const webhooks = await call(config, connection, 'GET', '/webhook', undefined, deadline)
    const url = `${CRM_API_ORIGIN}/api/whatsapp/fzap-webhook/${connection.id}`
    if (!Array.isArray(webhooks)) throw new FzapConnectionError('WEBHOOK', 409)
    const matches = webhooks.filter((item) => item?.url === url)
    if (matches.length !== 1) throw new FzapConnectionError('WEBHOOK', 409)
    const webhook = matches[0]
    const headers = Object.entries(webhook.headers ?? {}).filter(([key]) => key.toLowerCase() === 'x-fzap-webhook-token')
    if (headers.length !== 1 || headers[0][1] !== secret || !Array.isArray(webhook.events)
      || !['Message', 'ReadReceipt'].every((event) => webhook.events.includes(event))) throw new FzapConnectionError('WEBHOOK', 409)
  }

  function mutate(id, kind, operation) {
    const active = mutating.get(id)
    if (active) return active.kind === kind ? active.task : Promise.reject(new FzapConnectionError('BUSY', 409))
    const task = Promise.resolve().then(operation)
    mutating.set(id, { kind, task })
    task.finally(() => { if (mutating.get(id)?.task === task) mutating.delete(id) }).catch(() => {})
    return task
  }

  return {
    async list() {
      const config = getConfig()
      const atualizado_em = new Date(now()).toISOString()
      if (!config || !config.connections.length) return { configurado: false, provedor: 'fzap', conexoes: [], atualizado_em }
      const conexoes = await Promise.all(config.connections.map(async (connection) => {
        const dto = { id: connection.id, nome: connection.nome, finalidade: connection.finalidade,
          pareamento_habilitado: connection.pareamentoHabilitado !== false,
          ...(connection.pareamentoHabilitado === false ? { aviso: 'Conexão oficial preservada; pareamento por QR não preparado.' } : {}), atualizado_em }
        let owner
        try {
          const deadline = performance.now() + timeoutMs
          owner = await ownership(connection, 'get', deadline)
          const data = await session(config, connection, deadline)
          const estado = fzapSessionState(data)
          if (owner.owner === 'fzap' && estado === 'conectado') {
            assertProviderMetadata(data, connection)
            assertExpectedFzapIdentity(data)
          }
          if (estado !== 'conectando') seenQr.delete(connection.id)
          return { ...dto, estado, transporte_ativo: fzapTransportState(owner), conectado: estado === 'conectado', ...(estado === 'indeterminado' ? { erro: 'A FZAP não confirmou o estado desta conexão.' } : {}) }
        } catch {
          seenQr.delete(connection.id)
          return { ...dto, estado: 'indeterminado', transporte_ativo: fzapTransportState(owner), conectado: false, erro: 'Não foi possível consultar esta conexão agora.' }
        }
      }))
      return { configurado: true, provedor: 'fzap', conexoes, atualizado_em }
    },
    connect(id) {
      return mutate(id, 'connect', async () => {
        const { config, connection } = find(id)
        const deadline = performance.now() + timeoutMs
        let owner = await ownership(connection, 'get', deadline)
        let data = await session(config, connection, deadline)
        if (fzapSessionState(data) === 'indeterminado') throw new FzapConnectionError('UPSTREAM')
        if (owner.owner === 'evolution' && !owner.migrationRequested) {
          owner = await ownership(connection, 'request', deadline)
          if (owner.owner !== 'evolution' || owner.migrationRequested !== true) throw new FzapConnectionError('UPSTREAM')
        }
        if (fzapSessionState(data) === 'desconectado') {
          seenQr.delete(id)
          await call(config, connection, 'POST', '/session/connect', { immediate: true }, deadline)
          data = await session(config, connection, deadline)
          if (fzapSessionState(data) === 'indeterminado') throw new FzapConnectionError('UPSTREAM')
        }
        return qrFor(config, connection, data, deadline, owner)
      })
    },
    async qr(id) {
      const { config, connection } = find(id)
      const deadline = performance.now() + timeoutMs
      const owner = await ownership(connection, 'get', deadline)
      const data = await session(config, connection, deadline)
      if (fzapSessionState(data) === 'indeterminado') throw new FzapConnectionError('UPSTREAM')
      return qrFor(config, connection, data, deadline, owner)
    },
    complete(id) {
      return mutate(id, 'complete', async () => {
        const { config, connection } = find(id)
        const deadline = performance.now() + timeoutMs
        const owner = await ownership(connection, 'get', deadline)
        const data = await session(config, connection, deadline)
        if (owner.owner !== 'fzap' && owner.migrationRequested !== true) throw new FzapConnectionError('INTENT', 409)
        if (fzapSessionState(data) !== 'conectado') throw new FzapConnectionError('PAIRING', 409)
        assertPairingIdentity(data, owner.owner === 'evolution')
        assertProviderMetadata(data, connection, owner.owner === 'evolution')
        await assertWebhook(config, connection, deadline)
        // Re-read after webhook validation, before the durable database CAS.
        let confirmed = await session(config, connection, deadline)
        if (fzapSessionState(confirmed) !== 'conectado') throw new FzapConnectionError('PAIRING', 409)
        assertPairingIdentity(confirmed, owner.owner === 'evolution')
        assertProviderMetadata(confirmed, connection, owner.owner === 'evolution')
        if (owner.owner === 'evolution') {
          // Prepare provider metadata while the durable CRM owner is still Evolution.
          // PATCH replaces metadata, so preserve every field and verify exact readback.
          const expected = { ...metadataObject(confirmed), vivenzza_crm_transport: 'fzap' }
          if (expected.vivenzza_crm_expected_jid_sha256 == null) {
            // Explicit server-side authorization is consumed exactly once. Pin the
            // observed paired identity before the irreversible CRM owner change.
            expected.vivenzza_crm_expected_jid_sha256 = createHash('sha256').update(canonicalIdentity(confirmed)).digest('hex')
          }
          if (expected.vivenzza_crm_first_pairing_authorized === true) expected.vivenzza_crm_first_pairing_authorized = false
          checkedMetadata(expected)
          if (!isDeepStrictEqual(metadataObject(confirmed), expected)) {
            await call(config, connection, 'PATCH', '/session/metadata', { metadata: expected }, deadline)
            confirmed = await session(config, connection, deadline)
            if (!isDeepStrictEqual(metadataObject(confirmed), expected)) throw new FzapConnectionError('UPSTREAM')
            if (fzapSessionState(confirmed) !== 'conectado') throw new FzapConnectionError('PAIRING', 409)
          }
        }
        // Already-owned connections are validated, never automatically repaired.
        assertProviderMetadata(confirmed, connection)
        assertExpectedFzapIdentity(confirmed)
        const changed = owner.owner === 'fzap' ? owner : await ownership(connection, 'complete', deadline)
        if (changed.owner !== 'fzap') throw new FzapConnectionError('UPSTREAM')
        const persisted = await ownership(connection, 'get', deadline)
        if (persisted.owner !== 'fzap') throw new FzapConnectionError('UPSTREAM')
        seenQr.delete(id)
        return emptyQr(confirmed, persisted)
      })
    },
  }
}
