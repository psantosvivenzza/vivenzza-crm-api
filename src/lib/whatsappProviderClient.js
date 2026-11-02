import axios from 'axios'
import { readFzapConfig, assertExpectedFzapIdentity } from './fzapConnections.js'
import { ownershipStore as defaultOwnershipStore } from './whatsappOwnershipStore.js'

const LIMIT = 24 * 1024 * 1024
const validId = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)

export class WhatsappProviderError extends Error {
  constructor(code = 'FZAP_UNAVAILABLE', status) {
    super(code === 'FZAP_UNCERTAIN' ? 'O resultado do envio é indeterminado. Não repita automaticamente.' : 'A operação WhatsApp não pôde ser concluída.')
    this.name = 'WhatsappProviderError'
    this.code = code
    if (status) this.response = { status }
  }
}

// No raw axios errors, redirects, credential-bearing config or provider bodies escape.
export async function fzapProviderTransport({ baseURL, path, method, token, body, signal }) {
  const response = await fetch(new URL(path, baseURL), {
    method, signal, redirect: 'error', headers: { token, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if ([401, 403, 429].includes(response.status)) {
    await response.body?.cancel().catch(() => {})
    throw new WhatsappProviderError('FZAP_REJECTED', response.status)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new WhatsappProviderError()
  let size = 0
  const chunks = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > LIMIT) throw new WhatsappProviderError()
      chunks.push(value)
    }
    return { status: response.status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } finally { await reader.cancel().catch(() => {}) }
}

async function call(config, connection, method, path, body, options, sending = false) {
  const controller = new AbortController()
  let timer
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => (options.transport || fzapProviderTransport)({ baseURL: config.baseURL, token: connection.token, method, path, body, signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error()) }, 20_000) }),
    ])
    // Injected session transports may return the official JSON directly.
    const envelope = result?.body ?? result
    const status = result?.status ?? envelope?.code
    if ([400, 404, 422].includes(result?.status) && envelope?.success === false && envelope?.code === result.status) throw new WhatsappProviderError('FZAP_REJECTED', result.status)
    if (status !== 200 || envelope?.code !== 200 || envelope?.success !== true || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) throw new Error()
    return envelope.data
  } catch (error) {
    if (error instanceof WhatsappProviderError && error.code === 'FZAP_REJECTED' && [400, 404, 422].includes(error.response?.status)) throw new WhatsappProviderError('FZAP_REJECTED', error.response.status)
    if ([401, 403, 429].includes(error?.response?.status)) throw new WhatsappProviderError('FZAP_REJECTED', error.response.status)
    throw new WhatsappProviderError(sending ? 'FZAP_UNCERTAIN' : 'FZAP_UNAVAILABLE', sending ? undefined : 503)
  } finally { clearTimeout(timer) }
}

async function resolve(instanceName, options) {
  let config
  try { config = readFzapConfig(options.env || process.env) } catch { throw new WhatsappProviderError('FZAP_CONFIG', 503) }
  const connection = config?.connections.find((item) => item.instanceName === instanceName)
  if (!connection) return { provider: 'evolution' }
  let ownership
  try {
    ownership = await (options.ownershipStore || defaultOwnershipStore).get(connection.id)
    if (!ownership || !['evolution', 'fzap'].includes(ownership.owner) || ownership.instanceName !== connection.instanceName || ownership.finalidade !== connection.finalidade) throw new Error()
  } catch { throw new WhatsappProviderError('FZAP_OWNERSHIP', 503) }
  if (ownership.owner === 'evolution') return { provider: 'evolution', config, connection }
  const session = await call(config, connection, 'GET', '/session/status', undefined, options)
  if (typeof session.connected !== 'boolean' || typeof session.loggedIn !== 'boolean') throw new WhatsappProviderError('FZAP_UNAVAILABLE', 503)
  const metadata = session.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || metadata.vivenzza_crm_instance_name !== connection.instanceName
    || metadata.vivenzza_crm_transport !== 'fzap') throw new WhatsappProviderError('FZAP_UNAVAILABLE', 503)
  try { assertExpectedFzapIdentity(session) } catch { throw new WhatsappProviderError('FZAP_IDENTITY', 503) }
  return { provider: 'fzap', config, connection, session }
}

export async function whatsappTransportFor(instanceName, options = {}) { return (await resolve(instanceName, options)).provider }

function unsupported() { throw new WhatsappProviderError('FZAP_UNSUPPORTED') }
function mediaValue(value) {
  if (typeof value !== 'string' || !value || value.length > LIMIT) return unsupported()
  if (/^https:\/\//.test(value)) {
    const url = new URL(value)
    if (url.username || url.password) return unsupported()
    return value
  }
  if (/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\r\n]+$/i.test(value) || /^[A-Za-z0-9+/=\r\n]+$/.test(value)) return value
  return unsupported()
}

export function createWhatsappProviderClient(evolutionAxiosConfig, options = {}) {
  const legacy = (options.axiosImpl || axios).create(evolutionAxiosConfig)
  async function request(method, url, body, requestConfig) {
    const match = typeof url === 'string' && url.match(/^\/(message\/sendText|message\/sendWhatsAppAudio|message\/sendMedia|chat\/whatsappNumbers|instance\/connectionState|instance\/connect|chat\/getBase64FromMediaMessage)\/([^/?#]+)$/)
    if (!match) {
      // Unknown paths must not leak to Evolution if they target a registered instance.
      let segments, configured
      try {
        segments = String(url).split(/[?#]/)[0].split('/').map(decodeURIComponent)
        configured = readFzapConfig(options.env || process.env)
      } catch { throw new WhatsappProviderError('FZAP_CONFIG', 503) }
      for (const connection of configured?.connections || []) {
        if (segments.includes(connection.instanceName) && (await resolve(connection.instanceName, options)).provider === 'fzap') return unsupported()
      }
      return method === 'GET' ? legacy.get(url, requestConfig) : legacy.post(url, body, requestConfig)
    }
    let instanceName
    try { instanceName = decodeURIComponent(match[2]) } catch { return unsupported() }
    const owner = await resolve(instanceName, options)
    if (owner.provider === 'evolution') return method === 'GET' ? legacy.get(url, requestConfig) : legacy.post(url, body, requestConfig)
    const { config, connection, session } = owner
    const operation = match[1]
    if (operation === 'instance/connectionState' && method === 'GET') return { data: { instance: { state: session.connected === true && session.loggedIn === true ? 'open' : session.connected === false ? 'close' : 'unknown' } } }
    if (method !== 'POST') return unsupported()
    if (operation === 'chat/whatsappNumbers') {
      if (!Array.isArray(body?.numbers) || !body.numbers.length || body.numbers.some((n) => typeof n !== 'string' || !n || n.length > 100)) return unsupported()
      const data = await call(config, connection, 'POST', '/user/check', { phone: body.numbers }, options)
      if (!Array.isArray(data.users)) throw new WhatsappProviderError()
      const missing = [...new Set(body.numbers)].filter(number => !data.users.some(item => item.query === number))
      if (missing.length > 4) throw new WhatsappProviderError()
      const results = new Map()
      for (const number of new Set(body.numbers)) {
        let rows = data.users.filter(item => item.query === number)
        // FZap 1.36 deduplicates aliases in a batch. Missing does not mean false:
        // query that SAME input alone and require its exact result.
        if (rows.length === 0) {
          const single = await call(config, connection, 'POST', '/user/check', { phone: [number] }, options)
          if (!Array.isArray(single.users)) throw new WhatsappProviderError()
          rows = single.users.filter(item => item.query === number)
        }
        if (rows.length !== 1 || typeof rows[0].isInWhatsapp !== 'boolean' || (rows[0].isInWhatsapp && typeof rows[0].jid !== 'string')) throw new WhatsappProviderError()
        const row = rows[0]
        results.set(number, { exists: row.isInWhatsapp, jid: row.jid || number, number })
      }
      return { data: body.numbers.map(number => results.get(number)) }
    }
    if (operation === 'chat/getBase64FromMediaMessage') {
      const message = body?.message?.message
      const type = ['image', 'video', 'document', 'audio'].find((kind) => message?.[`${kind}Message`])
      if (!type) return unsupported()
      const media = message[`${type}Message`]
      const payload = { url: media.url, mediaKey: media.mediaKey, mimeType: media.mimetype, fileSha256: media.fileSha256, fileLength: Number(media.fileLength), generateLink: false }
      if (!payload.url || !payload.mediaKey || !payload.mimeType || !payload.fileSha256 || !Number.isFinite(payload.fileLength)) return unsupported()
      for (const key of ['directPath', 'fileEncSha256']) if (media[key]) payload[key] = media[key]
      const data = await call(config, connection, 'POST', `/chat/download${type}`, payload, options)
      // WhatsApp voice notes carry MIME parameters (audio/ogg; codecs=opus).
      // Accept token parameters while retaining the explicit base64 boundary.
      if (typeof data.data !== 'string' || !/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[ \t]*[a-z0-9!#$&^_.+-]+=[a-z0-9!#$&^_.+-]+)*;base64,/i.test(data.data)) throw new WhatsappProviderError()
      return { data: { base64: data.data.slice(data.data.indexOf(',') + 1), mimetype: data.mimeType } }
    }
    if (!operation.startsWith('message/')) return unsupported()
    if (session.connected !== true || session.loggedIn !== true) throw new WhatsappProviderError('FZAP_UNAVAILABLE', 503)
    if (typeof body?.number !== 'string' || !/^[0-9]+(?:@(s\.whatsapp\.net|lid))?$/.test(body.number)) return unsupported()
    const payload = { phone: body.number, check: true, noEcho: false }
    let kind
    if (operation === 'message/sendText') {
      if (typeof body.text !== 'string' || !body.text) return unsupported()
      kind = 'text'; payload.body = body.text; payload.async = false
    } else {
      kind = operation === 'message/sendWhatsAppAudio' ? 'audio' : body.mediatype
      if (!['image', 'audio', 'video', 'document'].includes(kind)) return unsupported()
      payload[kind] = mediaValue(operation === 'message/sendWhatsAppAudio' ? body.audio : body.media)
      if (kind !== 'document') payload.async = false
      if (kind === 'audio') payload.ptt = operation === 'message/sendWhatsAppAudio'
      if (typeof body.caption === 'string') payload.caption = body.caption
      if (typeof body.fileName === 'string') payload.fileName = body.fileName
      if (['image', 'document'].includes(kind) && typeof body.mimetype === 'string') payload.mimeType = body.mimetype
      if (kind === 'document' && !/^https:\/\//.test(payload.document) && !payload.fileName) return unsupported()
    }
    const data = await call(config, connection, 'POST', `/chat/send/${kind}`, payload, options, true)
    if (!validId(data.id) || data.details === 'Processing') throw new WhatsappProviderError('FZAP_UNCERTAIN')
    return { data: { key: { id: data.id, remoteJid: body.number.includes('@') ? body.number : `${body.number}@s.whatsapp.net`, fromMe: true } } }
  }
  return { get: (url, config) => request('GET', url, undefined, config), post: (url, data, config) => request('POST', url, data, config) }
}
