import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exigirSucessoFixture } from '../helpers/fixture-result.mjs'

test('preserva o resultado de sucesso, inclusive data null de DELETE', async () => {
  const resultado = { data: null, error: null }
  assert.equal(await exigirSucessoFixture('delete', Promise.resolve(resultado)), resultado)
})

test('FK na primeira limpeza interrompe a sequência e preserva causa', async () => {
  const causa = { code: '23503', message: 'foreign key violation' }
  let continuou = false
  await assert.rejects(async () => {
    await exigirSucessoFixture('limpar contas', Promise.resolve({ error: causa }))
    continuou = true
  }, erro => {
    assert.match(erro.message, /limpar contas.*23503.*foreign key violation/)
    assert.equal(erro.cause, causa)
    return true
  })
  assert.equal(continuou, false)
})

test('aceita builder thenable como o client Supabase', async () => {
  let executou = 0
  const resultado = await exigirSucessoFixture('insert', {
    then(resolve) { executou++; resolve({ data: { id: 'fixture' }, error: null }) },
  })
  assert.equal(executou, 1)
  assert.equal(resultado.data.id, 'fixture')
})

test('propaga rejeição da consulta', async () => {
  const causa = new Error('conexão indisponível')
  await assert.rejects(exigirSucessoFixture('insert', Promise.reject(causa)), erro => erro === causa)
})

test('recusa resultado ausente ou sem indicação de erro', async () => {
  for (const resultado of [undefined, null, {}, false]) {
    await assert.rejects(exigirSucessoFixture('delete', resultado), /sem contrato/)
  }
})

test('erro sem código também impede sucesso', async () => {
  await assert.rejects(exigirSucessoFixture('criar cliente', { error: { message: 'falhou' } }), /criar cliente falhou: falhou/)
})
