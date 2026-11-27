import test from 'node:test'
import assert from 'node:assert/strict'
import { validarConexaoPedidos } from '../../src/lib/pedidos-conexao.js'

test('SELECT 1 bem-sucedido preserva pool sem fechar ou executar escrita', async () => {
  const calls = []
  const pool = { query: async sql => calls.push(sql), end: async () => calls.push('END') }
  assert.equal(await validarConexaoPedidos(pool), pool)
  assert.deepEqual(calls, ['SELECT 1'])
})

for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET',
  'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED', 'EPIPE',
  '28P01', '28000', '3D000', '53300', '57P03', '57P01', '08006', '08001', '08004', '42501']) {
  test(`falha ${code}: código permitido, fechamento único e sem retry`, async () => {
    const calls = []
    const pool = {
      query: async sql => { calls.push(sql); throw Object.assign(new Error('segredo-cliente-host'), { code }) },
      end: async () => { calls.push('END') },
    }
    await assert.rejects(validarConexaoPedidos(pool), err => {
      assert.ok(err.message.includes(`Código: ${code}.`))
      assert.ok(!err.message.includes('segredo'))
      assert.equal(err.cause, undefined)
      return true
    })
    assert.deepEqual(calls, ['SELECT 1', 'END'])
  })
}

for (const code of ['senha-nao-publicar', 'ENOTFOUND\nsegredo', undefined, 53300]) {
  test(`código desconhecido ou malformado é descartado (${typeof code})`, async () => {
    const pool = { query: async () => { throw { code, message: 'segredo' } }, end: async () => {} }
    await assert.rejects(validarConexaoPedidos(pool), err => {
      assert.ok(err.message.includes('Código: NAO_CLASSIFICADO.'))
      assert.ok(!err.message.includes('segredo'))
      return true
    })
  })
}

test('erro de fechamento não mascara o código primário nem vaza mensagem', async () => {
  const pool = {
    query: async () => { throw Object.assign(new Error('segredo-primario'), { code: '28P01' }) },
    end: async () => { throw new Error('segredo-fechamento') },
  }
  await assert.rejects(validarConexaoPedidos(pool), err => {
    assert.ok(err.message.includes('Código: 28P01.'))
    assert.ok(!err.message.includes('segredo'))
    return true
  })
})

for (const thrown of [null, 'segredo-em-string']) {
  test(`rejeição sem objeto de erro é sanitizada (${typeof thrown})`, async () => {
    let closes = 0
    const pool = { query: async () => { throw thrown }, end: async () => { closes++ } }
    await assert.rejects(validarConexaoPedidos(pool), err => {
      assert.ok(err.message.includes('Código: NAO_CLASSIFICADO.'))
      assert.ok(!err.message.includes('segredo'))
      return true
    })
    assert.equal(closes, 1)
  })
}
