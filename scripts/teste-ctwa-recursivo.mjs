import assert from 'node:assert/strict'
import { detectarCtwaClid, caminhosIndicioAnuncio } from '../src/lib/ctwa.js'

assert.equal(detectarCtwaClid({ referral: { ctwa_clid: 'AAA' } }), 'AAA')
assert.equal(
  detectarCtwaClid({ message: { extendedTextMessage: { contextInfo: { externalAdReply: { ctwaClid: 'BBB' } } } } }),
  'BBB'
)
// caminho que a detecção antiga ignorava: contextInfo no nível do data
assert.equal(detectarCtwaClid({ contextInfo: { externalAdReply: { ctwaClid: 'CCC' } }, message: { conversation: 'oi' } }), 'CCC')
// tipo de mensagem fora da lista antiga
assert.equal(
  detectarCtwaClid({ message: { templateMessage: { contextInfo: { externalAdReply: { ctwaClid: 'DDD' } } } } }),
  'DDD'
)
assert.equal(detectarCtwaClid({ message: { conversation: 'oi' } }), null)
assert.equal(detectarCtwaClid(null), null)
assert.equal(detectarCtwaClid(undefined), null)
assert.equal(detectarCtwaClid({ referral: { ctwa_clid: 'PRIO' }, contextInfo: { ctwaClid: 'OUTRO' } }), 'PRIO')

const caminhos = caminhosIndicioAnuncio({ contextInfo: { externalAdReply: { title: 'segredo', ctwaClid: 'X' } } })
assert.ok(caminhos.some(c => c.endsWith('externalAdReply')))
assert.ok(!caminhos.join(' ').includes('segredo'))

console.log('teste-ctwa-recursivo: OK')
