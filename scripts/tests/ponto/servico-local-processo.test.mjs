import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { aguardarProntidaoLocal, encerrarProcessoLocal } from './_processo-local.mjs'

function processo() {
  const p = new EventEmitter()
  p.stdout = new EventEmitter(); p.exitCode = null; p.signalCode = null
  p.kill = () => { p.exitCode = 0; p.emit('exit', 0); return true }
  return p
}

test('prontidão aguarda a linha completa do token, mesmo fragmentada', async () => {
  const p = processo(); let pronto = false
  const espera = aguardarProntidaoLocal(p).then(token => { pronto = true; return token })
  p.stdout.emit('data', 'escutando em loopback\ntoken de pareamento: abc')
  await Promise.resolve(); assert.equal(pronto, false)
  p.stdout.emit('data', 'def\r\n')
  assert.equal(await espera, 'abcdef')
  assert.equal(p.listenerCount('exit'), 0)
})
test('processo já encerrado não aguarda prontidão nem tenta matar', async () => {
  const p = processo(); p.exitCode = 1
  p.kill = () => { throw Error('não deve chamar kill') }
  await assert.rejects(aguardarProntidaoLocal(p), /encerrou antes/)
  await encerrarProcessoLocal(p)
})
test('saída precoce rejeita prontidão e remove observadores', async () => {
  const p = processo(); const espera = aguardarProntidaoLocal(p)
  p.exitCode = 1; p.emit('exit', 1)
  await assert.rejects(espera, /encerrou antes/)
  assert.equal(p.stdout.listenerCount('data'), 0)
})
test('encerramento instala listener antes de pedir kill', async () => {
  const p = processo(); await encerrarProcessoLocal(p)
  assert.equal(p.exitCode, 0); assert.equal(p.listenerCount('exit'), 0)
})
test('prontidão e encerramento têm espera limitada', async () => {
  const p = processo()
  await assert.rejects(aguardarProntidaoLocal(p, 10), /Timeout/)
  p.kill = () => true
  await assert.rejects(encerrarProcessoLocal(p, 10), /Timeout/)
  assert.equal(p.listenerCount('exit'), 0)
})
test('falha de kill não expõe erro privado nem deixa listener', async () => {
  const p = processo(); p.kill = () => { throw Error('caminho-privado-sintetico') }
  await assert.rejects(encerrarProcessoLocal(p), e => /Falha ao encerrar/.test(e.message) && !e.message.includes('privado'))
  assert.equal(p.listenerCount('exit'), 0)
})
