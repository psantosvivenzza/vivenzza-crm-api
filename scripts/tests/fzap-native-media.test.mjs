import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { normalizeFzapWebhook } from '../../src/lib/fzapWebhookEvents.js'
import { createWhatsappProviderClient } from '../../src/lib/whatsappProviderClient.js'

const native = { URL: 'https://mmg.whatsapp.net/fixture', fileSHA256: 'fixture-sha', fileEncSHA256: 'fixture-enc',
  mediaKey: 'fixture-key', mimetype: 'application/pdf', fileLength: 861, directPath: '/fixture', caption: 'ficticio' }
function event(kind, media = native, wrapped = false) {
  const message = { [kind]: media }
  return { type: 'Message', event: { Info: { ID: 'FICTICIO-ONLY', Chat: '5511000000000@s.whatsapp.net', IsFromMe: false },
    Message: wrapped ? { documentWithCaptionMessage: { message } } : message } }
}
const token = 'fixture-only-not-a-real-token-0123456789'
const env = { FZAP_API_URL: 'https://fzap.vivenzzaprofessional.com.br', FZAP_CONNECTIONS_JSON: JSON.stringify([
  { id: 'comercial', instanceName: 'vivenzza', nome: 'Comercial', finalidade: 'comercial', token },
]) }
for (const kind of ['audioMessage', 'documentMessage']) {
  test(`normaliza nomes protobuf nativos em ${kind} preservando conteudo e origem`, () => {
    const payload = event(kind, native, kind === 'documentMessage')
    const before = JSON.stringify(payload)
    const result = normalizeFzapWebhook(payload, 'vivenzza')
    assert.equal(result.instance, 'vivenzza')
    assert.equal(result.data.messageType, kind)
    const media = result.data.message[kind]
    assert.equal(media.url, native.URL)
    assert.equal(media.fileSha256, native.fileSHA256)
    assert.equal(media.fileEncSha256, native.fileEncSHA256)
    assert.equal(media.caption, 'ficticio')
    assert.equal(media.mediaKey, native.mediaKey)
    assert.equal(JSON.stringify(payload), before, 'não altera o envelope original')
  })
  test(`anexo nativo ${kind} chega ao download do adapter sem Evolution ou rede real`, async () => {
    const normalized = normalizeFzapWebhook(event(kind), 'vivenzza')
    let downloads = 0
    const client = createWhatsappProviderClient({}, { env,
      axiosImpl: { create: () => ({ get: () => assert.fail('Evolution'), post: () => assert.fail('Evolution') }) },
      ownershipStore: { get: async () => ({ owner: 'fzap', instanceName: 'vivenzza', finalidade: 'comercial' }) },
      transport: async ({ path, body }) => {
        if (path === '/session/status') return { code: 200, success: true, data: { connected: true, loggedIn: true,
          jid: '5511000000999@s.whatsapp.net', metadata: { vivenzza_crm_instance_name: 'vivenzza', vivenzza_crm_transport: 'fzap',
            vivenzza_crm_expected_jid_sha256: createHash('sha256').update('5511000000999').digest('hex') } } }
        downloads++
        assert.equal(path, kind === 'audioMessage' ? '/chat/downloadaudio' : '/chat/downloaddocument')
        assert.equal(body.url, native.URL)
        assert.equal(body.fileSha256, native.fileSHA256)
        assert.equal(body.fileEncSha256, native.fileEncSHA256)
        assert.equal(body.directPath, '/fixture')
        return { code: 200, success: true, data: { data: 'data:application/pdf;base64,JVBERi0=', mimeType: 'application/pdf' } }
      } })
    const result = await client.post('/chat/getBase64FromMediaMessage/vivenzza', { message: { message: normalized.data.message } })
    assert.equal(downloads, 1)
    assert.equal(result.data.base64, 'JVBERi0=')
  })
}

test('preserva formato camelCase existente e aceita aliases identicos', () => {
  const legacy = { url: native.URL, fileSha256: native.fileSHA256, fileEncSha256: native.fileEncSHA256, mediaKey: 'key' }
  assert.deepEqual(normalizeFzapWebhook(event('audioMessage', legacy), 'vivenzza').data.message.audioMessage, legacy)
  const identical = { ...native, ...legacy }
  assert.deepEqual(normalizeFzapWebhook(event('documentMessage', identical), 'vivenzza').data.message.documentMessage, identical)
})

test('preserva mensagem mas bloqueia download de aliases conflitantes ou nativos invalidos', () => {
  for (const [key, canonical] of [['URL', 'url'], ['fileSHA256', 'fileSha256'], ['fileEncSHA256', 'fileEncSha256']]) {
    for (const bad of [{ ...native, [canonical]: 'different' }, { ...native, [key]: 123 }, { ...native, [key]: '' }]) {
      const result = normalizeFzapWebhook(event('audioMessage', bad), 'vivenzza')
      assert.equal(result.data.messageType, 'audioMessage')
      assert.equal(result.data.key.id, 'FICTICIO-ONLY')
      for (const alias of ['url', 'fileSha256', 'fileEncSha256']) assert.equal(result.data.message.audioMessage[alias], undefined)
      assert.equal(result.data.message.audioMessage.caption, 'ficticio')
    }
  }
})

test('imagens e videos usam a mesma conversao de campos, sem alterar textos', () => {
  for (const type of ['imageMessage', 'videoMessage']) {
    const result = normalizeFzapWebhook(event(type), 'vivenzza')
    assert.equal(result.data.message[type].url, native.URL)
    assert.equal(result.data.message[type].fileSha256, native.fileSHA256)
  }
  const result = normalizeFzapWebhook(event('conversation', 'texto ficticio'), 'vivenzza')
  assert.equal(result.data.message.conversation, 'texto ficticio')
})

test('wrappers nativos mantem contexto e null nativo nao apaga alias existente', () => {
  for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2']) {
    const payload = event('audioMessage')
    payload.event.Message = { messageContextInfo: { fixture: true }, [wrapper]: { message: payload.event.Message } }
    const result = normalizeFzapWebhook(payload, 'vivenzza')
    assert.equal(result.data.message.audioMessage.url, native.URL)
    assert.deepEqual(result.data.message.messageContextInfo, { fixture: true })
  }
  const result = normalizeFzapWebhook(event('audioMessage', { ...native, URL: null, url: native.URL }), 'vivenzza')
  assert.equal(result.data.message.audioMessage.url, native.URL)
})
