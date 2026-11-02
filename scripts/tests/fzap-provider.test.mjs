import test from 'node:test'
import { createHash } from 'node:crypto'
const ownJid = '5511000000999@s.whatsapp.net'
const ownHash = createHash('sha256').update('5511000000999').digest('hex')
import assert from 'node:assert/strict'
import { createWhatsappProviderClient, whatsappTransportFor } from '../../src/lib/whatsappProviderClient.js'
import { normalizeFzapWebhook } from '../../src/lib/fzapWebhookEvents.js'

const env = { FZAP_API_URL: 'https://fzap.vivenzzaprofessional.com.br', FZAP_CONNECTIONS_JSON: JSON.stringify([
  { id: 'commercial', instanceName: 'vivenzza', nome: 'Comercial', finalidade: 'comercial', token: 'a'.repeat(40) },
  { id: 'financial', instanceName: 'vivenzza-financeiro', nome: 'Financeiro', finalidade: 'financeiro', token: 'b'.repeat(40) },
]) }
const store = (owner = 'fzap') => ({ get: async (id) => ({ owner, migrationRequested: false, instanceName: id === 'commercial' ? 'vivenzza' : 'vivenzza-financeiro', finalidade: id === 'commercial' ? 'comercial' : 'financeiro' }) })
const ok = (data) => ({ code: 200, success: true, data })

test('download aceita audio Ogg com parametro codecs preservando bytes e MIME', async () => {
  const f = fixture({ handler: () => ok({ data: 'data:audio/ogg; codecs=opus;base64,T2dnUw==', mimeType: 'audio/ogg; codecs=opus' }) })
  const result = await f.client.post('/chat/getBase64FromMediaMessage/vivenzza', { message: { message: { audioMessage: { url: 'https://mmg.whatsapp.net/fixture', mediaKey: 'fixture', mimetype: 'audio/ogg; codecs=opus', fileSha256: 'fixture', fileLength: 4 } } } })
  assert.deepEqual(result.data, { base64: 'T2dnUw==', mimetype: 'audio/ogg; codecs=opus' })
})

for (const uri of ['data:audio/ogg; codecs=opus,T2dnUw==', 'data:audio/ogg; codecs=opus\n;base64,T2dnUw==', 'https://fixture.invalid/audio', 'data:audio/ogg;;base64,T2dnUw==']) {
  test('download recusa envelope sem base64 explicito ou parametro malformado: '+JSON.stringify(uri), async () => {
    const f = fixture({ handler: () => ok({ data: uri, mimeType: 'audio/ogg' }) })
    await assert.rejects(f.client.post('/chat/getBase64FromMediaMessage/vivenzza', { message: { message: { audioMessage: { url: 'https://mmg.whatsapp.net/fixture', mediaKey: 'fixture', mimetype: 'audio/ogg', fileSha256: 'fixture', fileLength: 4 } } } }), { code: 'FZAP_UNAVAILABLE' })
    assert.equal(f.calls.length, 2)
    assert.equal(f.legacy.length, 1)
  })
}
function fixture({ owner = 'fzap', connected = true, loggedIn = true, flag = 'fzap', handler = () => ok({ id: 'ABC123' }), sessionError } = {}) {
  const calls = [], legacy = []
  const axiosImpl = { create(config) { legacy.push(config); return { get: (...args) => { legacy.push(args); return { data: 'legacy-get' } }, post: (...args) => { legacy.push(args); return { data: 'legacy-post' } } } } }
  const transport = async (request) => {
    calls.push(request)
    if (request.path === '/session/status') { if (sessionError) throw sessionError; return ok({ jid: ownJid, connected, loggedIn, metadata: flag === undefined ? {} : { vivenzza_crm_expected_jid_sha256: ownHash, vivenzza_crm_transport: flag, vivenzza_crm_instance_name: request.token === 'a'.repeat(40) ? 'vivenzza' : 'vivenzza-financeiro' } }) }
    return handler(request)
  }
  return { client: createWhatsappProviderClient({ baseURL: 'https://legacy.invalid', headers: { apikey: 'legacy-secret' } }, { env, transport, axiosImpl, ownershipStore: store(owner) }), calls, legacy, transport }
}
test('unregistered instance preserves exact legacy config and arguments', async () => {
  const f = fixture(); const body = { text: 'teste', number: '5511000000000' }; const config = { timeout: 123 }
  assert.equal((await f.client.post('/message/sendText/another', body, config)).data, 'legacy-post')
  assert.deepEqual(f.legacy[1], ['/message/sendText/another', body, config]); assert.equal(f.calls.length, 0)
})
test('durable Evolution owner stays operational without calling FZAP', async () => {
  const f = fixture({ owner: 'evolution', sessionError: new Error('FZAP offline') }); await f.client.post('/message/sendText/vivenzza', { number: '5511000000000', text: 'teste' })
  assert.equal(f.calls.length, 0); assert.equal(f.legacy.length, 2)
})
test('missing metadata never downgrades durable FZAP owner', async () => {
  await assert.rejects(whatsappTransportFor('vivenzza', { env, transport: async () => ok({ connected: true, loggedIn: true }), ownershipStore: store() }), {code:'FZAP_UNAVAILABLE'})
})
test('migrated provider requires pinned JID hash, including after another number is paired', async () => {
  for (const data of [
    { jid: ownJid, metadata: { vivenzza_crm_transport: 'fzap', vivenzza_crm_instance_name: 'vivenzza', vivenzza_crm_first_pairing_authorized: true } },
    { jid: '5511000000888@s.whatsapp.net', metadata: { vivenzza_crm_transport: 'fzap', vivenzza_crm_instance_name: 'vivenzza', vivenzza_crm_expected_jid_sha256: ownHash, vivenzza_crm_first_pairing_authorized: true } },
  ]) {
    await assert.rejects(whatsappTransportFor('vivenzza', { env, ownershipStore: store(), transport: async () => ok({ connected: true, loggedIn: true, ...data }) }), { code: 'FZAP_IDENTITY' })
  }
})
test('unavailable status fails closed, no write or Evolution request', async () => {
  const f = fixture({ sessionError: new Error('secret token') })
  await assert.rejects(f.client.post('/message/sendText/vivenzza', {}), (e) => e.response.status === 503 && !JSON.stringify(e).includes('secret'))
  assert.equal(f.legacy.length, 1); assert.equal(f.calls.length, 1)
})
test('text mapped exactly, ownership rechecked on every call', async () => {
  const f = fixture(); const result = await f.client.post('/message/sendText/vivenzza', { number: '5511000000000', text: 'teste' })
  assert.deepEqual(f.calls[1].body, { phone: '5511000000000', check: true, noEcho: false, body: 'teste', async: false })
  assert.deepEqual(result, { data: { key: { id: 'ABC123', remoteJid: '5511000000000@s.whatsapp.net', fromMe: true } } })
  await f.client.get('/instance/connectionState/vivenzza'); assert.equal(f.calls.filter((c) => c.path === '/session/status').length, 2)
})
for (const response of [{ status: 202, body: { code: 202, success: true, data: { id: 'ABC', details: 'Processing' } } }, ok({}), ok({ id: 'ABC', details: 'Processing' }), ok({ id: '<invalid>' })]) {
  test(`ambiguous response ${JSON.stringify(response)} never duplicates/fails over`, async () => {
    const f = fixture({ handler: () => response })
    await assert.rejects(f.client.post('/message/sendText/vivenzza', { number: '5511000000000', text: 'teste' }), { code: 'FZAP_UNCERTAIN' })
    assert.equal(f.calls.length, 2); assert.equal(f.legacy.length, 1)
  })
}
test('timeout error sanitized without retryable network code', async () => {
  const f = fixture({ handler: () => { throw Object.assign(new Error('token secret'), { code: 'ETIMEDOUT', config: { token: 'secret' } }) } })
  await assert.rejects(f.client.post('/message/sendText/vivenzza', { number: '5511000000000', text: 'teste' }), (e) => e.code === 'FZAP_UNCERTAIN' && !JSON.stringify(e).includes('secret'))
  assert.equal(f.calls.length, 2)
})
for (const status of [401, 403, 429]) test(`known HTTP ${status} preserved safely`, async () => {
  const f = fixture({ handler: () => { throw { response: { status, data: 'secret' }, config: { token: 'secret' } } } })
  await assert.rejects(f.client.post('/message/sendText/vivenzza', { number: '5511000000000', text: 'teste' }), (e) => e.response.status === status && !JSON.stringify(e).includes('secret'))
})
for (const status of [400,404,422]) test(`matching explicit HTTP ${status} rejection is definitive without payload exposure`, async () => {
  const f = fixture({handler:()=>({status,body:{code:status,success:false,message:'provider-secret'}})})
  await assert.rejects(f.client.post('/message/sendText/vivenzza',{number:'5511000000000',text:'teste'}),error=>error.code==='FZAP_REJECTED'&&error.response.status===status&&!JSON.stringify(error).includes('provider-secret'))
  assert.equal(f.calls.length,2)
})
test('5xx, contradictory or malformed rejection envelopes remain uncertain',async()=>{
  for(const response of [
    {status:500,body:{code:500,success:false}},
    {status:400,body:{code:422,success:false}},
    {status:400,body:{code:400,success:true}},
    {status:422,body:{}},
    {code:400,success:false},
  ]){
    const f=fixture({handler:()=>response})
    await assert.rejects(f.client.post('/message/sendText/vivenzza',{number:'5511000000000',text:'teste'}),{code:'FZAP_UNCERTAIN'})
    assert.equal(f.calls.length,2)
  }
  const f=fixture({handler:()=>{throw new SyntaxError('invalid JSON provider-secret')}})
  await assert.rejects(f.client.post('/message/sendText/vivenzza',{number:'5511000000000',text:'teste'}),{code:'FZAP_UNCERTAIN'})
})
test('disconnected FZAP remains authoritative with honest status', async () => {
  const f = fixture({connected:false,loggedIn:false}); assert.equal((await f.client.get('/instance/connectionState/vivenzza')).data.instance.state, 'close')
  await assert.rejects(f.client.get('/instance/connect/vivenzza'), { code: 'FZAP_UNSUPPORTED' }); assert.equal(f.legacy.length, 1)
})
test('disconnected or unauthenticated session rejects send before any POST with definitive unavailability', async () => {
  for (const state of [{connected:false,loggedIn:false},{connected:true,loggedIn:false}]) {
    const f = fixture(state)
    await assert.rejects(f.client.post('/message/sendText/vivenzza',{number:'5511000000000',text:'teste'}), {code:'FZAP_UNAVAILABLE'})
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'GET');assert.equal(f.legacy.length,1)
  }
})
test('unknown operation on FZAP does not reach Evolution', async () => {
  const f = fixture(); await assert.rejects(f.client.post('/chat/unknown/vivenzza', {}), { code: 'FZAP_UNSUPPORTED' }); assert.equal(f.legacy.length, 1)
})
test('unsupported query-bearing operation cannot bypass FZAP ownership', async () => {
  const f = fixture(); await assert.rejects(f.client.post('/message/sendText/vivenzza?unexpected=1', {}), { code: 'FZAP_UNSUPPORTED' }); assert.equal(f.legacy.length, 1)
})
test('malformed session cannot masquerade as absent migration metadata', async () => {
  await assert.rejects(whatsappTransportFor('vivenzza', { env, transport: async () => ok({}), ownershipStore: store() }), (error) => error.code === 'FZAP_UNAVAILABLE' && error.response.status === 503)
})
test('durable ownership change is observed without restart or permanent cache', async () => {
  let owner = 'evolution'; let calls=0
  const options = { env, ownershipStore:{get:async()=>({...await store(owner).get('commercial')})}, transport: async () => {calls++;return ok({ jid: ownJid, connected: true, loggedIn: true, metadata: {vivenzza_crm_expected_jid_sha256: ownHash,vivenzza_crm_transport:'fzap',vivenzza_crm_instance_name:'vivenzza'} })} }
  assert.equal(await whatsappTransportFor('vivenzza',options),'evolution');assert.equal(calls,0);owner='fzap'
  assert.equal(await whatsappTransportFor('vivenzza',options),'fzap');assert.equal(calls,1)
})
test('channels use distinct configured tokens and names', async () => {
  const f = fixture(); await f.client.post('/message/sendText/vivenzza-financeiro', { number: '5511000000000', text: 'teste' }); assert.equal(f.calls[1].token, 'b'.repeat(40)); assert.equal(f.legacy.length, 1)
})
for (const type of ['image', 'video', 'document', 'audio']) test(`media ${type} maps official field`, async () => {
  const f = fixture(); await f.client.post('/message/sendMedia/vivenzza', { number: '5511000000000', mediatype: type, media: 'data:application/octet-stream;base64,YQ==', fileName: 'teste.bin', caption: 'teste' })
  assert.equal(f.calls[1].path, `/chat/send/${type}`); assert.equal(f.calls[1].body[type], 'data:application/octet-stream;base64,YQ==')
})
test('voice maps to ptt and insecure media URL rejected before write', async () => {
  const f = fixture(); await f.client.post('/message/sendWhatsAppAudio/vivenzza', { number: '5511000000000', audio: 'YQ==' }); assert.equal(f.calls[1].body.ptt, true)
  await assert.rejects(f.client.post('/message/sendMedia/vivenzza', { number: '5511000000000', mediatype: 'image', media: 'http://bad.invalid' }), { code: 'FZAP_UNSUPPORTED' }); assert.equal(f.calls.length, 3)
})
test('number checks preserve query and require explicit boolean', async () => {
  const f = fixture({ handler: () => ok({ users: [{ query: '5511000000000', isInWhatsapp: false }] }) })
  assert.deepEqual((await f.client.post('/chat/whatsappNumbers/vivenzza', { numbers: ['5511000000000'] })).data, [{ exists: false, jid: '5511000000000', number: '5511000000000' }])
  assert.deepEqual(f.calls[1].body, { phone: ['5511000000000'] })
  const bad = fixture({ handler: () => ok({ users: [{ query: '5511000000000', isInWhatsapp: 'true' }] }) }); await assert.rejects(bad.client.post('/chat/whatsappNumbers/vivenzza', { numbers: ['5511000000000'] }))
})
test('official media download maps metadata and base64 envelope', async () => {
  const f = fixture({ handler: () => ok({ data: 'data:image/png;base64,YQ==', mimeType: 'image/png' }) })
  const result = await f.client.post('/chat/getBase64FromMediaMessage/vivenzza', { message: { message: { imageMessage: { url: 'https://mmg.whatsapp.net/test', mediaKey: 'key', mimetype: 'image/png', fileSha256: 'hash', fileLength: 1 } } } })
  assert.equal(f.calls[1].path, '/chat/downloadimage'); assert.deepEqual(result.data, { base64: 'YQ==', mimetype: 'image/png' })
})
const message = { type: 'Message', instance: 'attacker', event: { Info: { ID: 'ABC123', Chat: '5511000000000@s.whatsapp.net', IsFromMe: false, Timestamp: '2026-10-29T12:00:00Z', PushName: 'Fictício' }, Message: { extendedTextMessage: { text: 'teste', contextInfo: { externalAdReply: { sourceId: 'ctwa-test' } } } } } }
test('normalizer fixes identity, preserves exact context and stable IDs', () => {
  const result = normalizeFzapWebhook(message, 'vivenzza'); assert.equal(result.instance, 'vivenzza'); assert.equal(result.data.key.id, 'ABC123'); assert.deepEqual(result.data.message, message.event.Message); assert.equal(result.data.messageTimestamp, 1793275200)
})
test('unknown, group, broadcast, malformed and missing IDs ignored', () => {
  for (const chat of ['123@g.us', 'status@broadcast', '', 'not-jid']) assert.equal(normalizeFzapWebhook({ ...message, event: { ...message.event, Info: { ...message.event.Info, Chat: chat } } }, 'vivenzza'), null)
  assert.equal(normalizeFzapWebhook({ type: 'unknown', event: {} }, 'vivenzza'), null)
  assert.equal(normalizeFzapWebhook({ ...message, event: { ...message.event, Info: { ...message.event.Info, ID: undefined } } }, 'vivenzza'), null)
})
test('receipt stable IDs and known types; read-self not delivery', () => {
  const event = { Chat: '5511000000000@s.whatsapp.net', MessageIDs: ['ABC123', 'ABC123'], Type: 'read' }
  assert.deepEqual(normalizeFzapWebhook({ type: 'ReadReceipt', event }, 'vivenzza').data, [{ key: { id: 'ABC123', remoteJid: event.Chat }, status: 'READ' }])
  assert.equal(normalizeFzapWebhook({ type: 'Receipt', event: { ...event, Type: 'read-self' } }, 'vivenzza'), null)
})
test('LID alternate identity follows sender/recipient direction without rewriting', () => {
  const info = { ...message.event.Info, Chat: '123@lid', SenderAlt: '5511000000001@s.whatsapp.net', RecipientAlt: '5511000000002@s.whatsapp.net' }
  assert.equal(normalizeFzapWebhook({ ...message, event: { ...message.event, Info: info } }, 'vivenzza').data.key.remoteJidAlt, info.SenderAlt)
  assert.equal(normalizeFzapWebhook({ ...message, event: { ...message.event, Info: { ...info, IsFromMe: true } } }, 'vivenzza').data.key.remoteJidAlt, info.RecipientAlt)
})

test('FZap deduplica variantes no lote: consulta apenas a entrada ausente sem inferir identidade',async()=>{
 const numbers=['5511000000001','551100000001'];const f=fixture({handler:req=>ok({users:[{query:req.body.phone[0],isInWhatsapp:true,jid:req.body.phone[0]+'@s.whatsapp.net'}]})})
 const response=await f.client.post('/chat/whatsappNumbers/vivenzza',{numbers})
 assert.deepEqual(response.data.map(x=>x.number),numbers)
 assert.deepEqual(f.calls.filter(x=>x.path==='/user/check').map(x=>x.body.phone),[numbers,[numbers[1]]])
 assert.ok(f.calls.every(x=>!x.path.startsWith('/chat/send')))
})
test('resultado ausente ou duplicado após consulta individual continua indisponível, sem falso negativo',async()=>{
 for(const users of [[],[{query:'5511000000001',isInWhatsapp:true,jid:'5511000000001@s.whatsapp.net'},{query:'5511000000001',isInWhatsapp:false}]]){
 const f=fixture({handler:()=>ok({users})});await assert.rejects(f.client.post('/chat/whatsappNumbers/vivenzza',{numbers:['5511000000001']}),{code:'FZAP_UNAVAILABLE'});assert.equal(f.legacy.length,1)
 }
})
