import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeFzapWebhook } from '../../src/lib/fzapWebhookEvents.js'
const payload = (message) => ({ type: 'Message', event: { Info: { ID: 'id1', Chat: '100@s.whatsapp.net', IsFromMe: false }, Message: message } })
for (const wrapper of ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage']) {
  test(`unwrap ${wrapper} preserves caption, media key and quoted context`, () => {
    const content = { documentMessage: { caption: 'example', mediaKey: 'fixture', contextInfo: { stanzaID: 'quoted-id' } } }
    const result = normalizeFzapWebhook(payload({ [wrapper]: { message: content } }), 'allowlisted')
    assert.equal(result.data.messageType, 'documentMessage')
    assert.deepEqual(result.data.message, content)
  })
}
test('unwrap four layers; reject depth5 and malformed wrappers; preserve inner precedence', () => {
  let content = { conversation: 'example', messageContextInfo: { thread: 'inner' } }
  for (let i = 0; i < 4; i++) content = { messageContextInfo: { thread: 'outer' }, ephemeralMessage: { message: content } }
  const normalized = normalizeFzapWebhook(payload(content), 'allowed')
  assert.equal(normalized.data.message.conversation, 'example')
  assert.equal(normalized.data.message.messageContextInfo.thread, 'inner')
  assert.equal(normalizeFzapWebhook(payload({ viewOnceMessageV2: { message: content } }), 'allowed'), null)
  assert.equal(normalizeFzapWebhook(payload({ viewOnceMessageV2: {} }), 'allowed'), null)
})
test('outer message context preserved when inner absent, unknown system inner ignored', () => {
  const wrapped = { messageContextInfo: { thread: 'outer' }, documentWithCaptionMessage: { message: { conversation: 'example' } } }
  assert.equal(normalizeFzapWebhook(payload(wrapped), 'allowed').data.message.messageContextInfo.thread, 'outer')
  assert.equal(normalizeFzapWebhook(payload({ ephemeralMessage: { message: { protocolMessage: {} } } }), 'allowed'), null)
})

test('numeric device routing suffix removed without changing identity digits', () => {
  const value = payload({ conversation: 'example' })
  value.event.Info.Chat = '5511999990000:12@s.whatsapp.net'
  assert.equal(normalizeFzapWebhook(value, 'allowed').data.key.remoteJid, '5511999990000@s.whatsapp.net')
  value.event.Info.Chat = '888000:3@lid'; value.event.Info.SenderAlt = '5511888880000:2@s.whatsapp.net'
  const normalized = normalizeFzapWebhook(value, 'allowed')
  assert.equal(normalized.data.key.remoteJid, '888000@lid')
  assert.equal(normalized.data.key.remoteJidAlt, '5511888880000@s.whatsapp.net')
  value.event.Info.Chat = '5511999990000:abc@s.whatsapp.net'
  assert.equal(normalizeFzapWebhook(value, 'allowed'), null)
  const receipt = { type: 'Receipt', event: { Chat: '5511888880000:7@s.whatsapp.net', Type: 'read', MessageIDs: ['ID1'] } }
  assert.equal(normalizeFzapWebhook(receipt, 'allowed').data[0].key.remoteJid, '5511888880000@s.whatsapp.net')
})
