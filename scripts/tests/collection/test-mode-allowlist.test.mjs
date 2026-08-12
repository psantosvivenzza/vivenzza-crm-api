// PASSO 9/34 — COLLECTION_TEST_MODE + allowlist server-side. Prova que, mesmo
// que o código chamador tenha um bug e tente mandar pra um número fora da
// allowlist, o envio é bloqueado ANTES de qualquer chamada HTTP real.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let fakeEvolution, enviarTexto

before(async () => {
  fakeEvolution = await iniciarAmbienteDeTeste()
  ;({ enviarTexto } = await import('../../../src/lib/collection/evolutionAdapter.js'))
})
after(async () => { await pararAmbienteDeTeste() })

test('COLLECTION_TEST_MODE bloqueia envio para número fora da allowlist', async () => {
  process.env.COLLECTION_TEST_MODE = 'true'
  process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000001,5551900000002'
  fakeEvolution.resetar()
  fakeEvolution.controlarInstancia('wa-testmode', { comportamento: 'ok' })

  await assert.rejects(
    () => enviarTexto({ instance_name: 'wa-testmode', api_key_env_var: 'EVOLUTION_API_KEY' }, '5551987654321', 'texto qualquer'),
    /não está em COLLECTION_TEST_PHONE_ALLOWLIST/
  )
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'nenhuma chamada HTTP real deve ter acontecido — bloqueado antes')

  process.env.COLLECTION_TEST_MODE = 'false'
})

test('COLLECTION_TEST_MODE permite envio para número presente na allowlist', async () => {
  process.env.COLLECTION_TEST_MODE = 'true'
  process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000001'
  fakeEvolution.resetar()
  fakeEvolution.controlarInstancia('wa-testmode', { comportamento: 'ok' })

  const resultado = await enviarTexto({ instance_name: 'wa-testmode', api_key_env_var: 'EVOLUTION_API_KEY' }, '5551900000001', 'texto permitido')
  assert.equal(resultado.ok, true)
  assert.equal(fakeEvolution.mensagensEnviadas.length, 1)

  process.env.COLLECTION_TEST_MODE = 'false'
})

// FASE C.3A (homologação, 2026-08-12) — achado real da revisão: o matching
// antigo (endsWith em dígitos brutos) tinha falso-positivo real. Estes testes
// prova a comparação canônica nova (telefonesEquivalentes, em src/lib/telefone.js).
test('COLLECTION_TEST_MODE: mesmo número em formatos diferentes (com/sem código de país, com/sem 9º dígito) é reconhecido como o MESMO', async () => {
  process.env.COLLECTION_TEST_MODE = 'true'
  process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '(51) 90000-0001' // formatado, com parênteses/espaço/hífen
  fakeEvolution.resetar()
  fakeEvolution.controlarInstancia('wa-testmode-formato', { comportamento: 'ok' })

  for (const variante of ['5551900000001', '+55 51 90000-0001', '51900000001']) {
    fakeEvolution.resetar()
    const resultado = await enviarTexto({ instance_name: 'wa-testmode-formato', api_key_env_var: 'EVOLUTION_API_KEY' }, variante, 'x')
    assert.equal(resultado.ok, true, `variante "${variante}" deveria ser reconhecida como o mesmo número da allowlist`)
  }

  process.env.COLLECTION_TEST_MODE = 'false'
})

test('COLLECTION_TEST_MODE: allowlist SEM DDD não bate por sufixo com número de OUTRO DDD terminado nos mesmos dígitos (achado real — endsWith antigo tinha esse falso-positivo)', async () => {
  process.env.COLLECTION_TEST_MODE = 'true'
  process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '900000001' // sem DDD, cadastro incompleto de propósito
  fakeEvolution.resetar()
  fakeEvolution.controlarInstancia('wa-testmode-ddd', { comportamento: 'ok' })

  // DDD 11 (São Paulo), termina nos mesmos 9 dígitos do allowlist incompleto —
  // NUNCA deveria ser tratado como o mesmo número.
  await assert.rejects(
    () => enviarTexto({ instance_name: 'wa-testmode-ddd', api_key_env_var: 'EVOLUTION_API_KEY' }, '5511900000001', 'x'),
    /não está em COLLECTION_TEST_PHONE_ALLOWLIST/
  )
  assert.equal(fakeEvolution.mensagensEnviadas.length, 0)

  process.env.COLLECTION_TEST_MODE = 'false'
})

test('COLLECTION_TEST_MODE: mensagem de bloqueio NUNCA expõe o telefone completo (mascarado)', async () => {
  process.env.COLLECTION_TEST_MODE = 'true'
  process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000099'
  fakeEvolution.resetar()
  fakeEvolution.controlarInstancia('wa-testmode-mascara', { comportamento: 'ok' })

  try {
    await enviarTexto({ instance_name: 'wa-testmode-mascara', api_key_env_var: 'EVOLUTION_API_KEY' }, '5551987654321', 'x')
    assert.fail('deveria ter sido bloqueado')
  } catch (err) {
    assert.equal(err.message.includes('5551987654321'), false, 'número completo não deveria aparecer na mensagem de erro')
    assert.ok(err.message.includes('4321'), 'últimos 4 dígitos devem continuar visíveis (mascaramento parcial)')
    assert.ok(err.message.includes('*'), 'deveria ter asteriscos mascarando o resto')
  }

  process.env.COLLECTION_TEST_MODE = 'false'
})
