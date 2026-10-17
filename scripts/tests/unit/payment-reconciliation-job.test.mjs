// Job real; fronteira do sweep substituída antes de carregar qualquer cliente.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const key = Symbol.for('vivenzza.payment.job.test')
const fixture = globalThis[key] = {}
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/src/jobs/payment-reconciliation-sweep.js') && specifier.endsWith('/paymentGuard.js')) {
    return { shortCircuit: true, url: 'data:text/javascript,export async function varrerTitulosPendentesEcancelarQuitados(){const f=globalThis[Symbol.for("vivenzza.payment.job.test")];if(f.error)throw f.error;return f.result}' }
  }
  return next(specifier, context)
} })
const { runPaymentReconciliationSweep } = await import('../../../src/jobs/payment-reconciliation-sweep.js')

for (const [code, expected] of [
  ['PGRST202', 'rpc_indisponivel'],
  ['55P03', 'timeout_lock'],
  ['25001', 'contexto_transacao'],
  ['40P01', 'deadlock'],
  ['40001', 'falha_serializacao'],
  ['42501', 'permissao_negada'],
  ['42P01', 'schema_incompativel'],
  ['PGRST204', 'schema_incompativel'],
  ['PGRST205', 'schema_incompativel'],
  ['57014', 'consulta_cancelada'],
  ['ECONNRESET', 'conexao_indisponivel'],
  ['ETIMEDOUT', 'conexao_indisponivel'],
  ['08006', 'conexao_indisponivel'],
  ['23514', 'integridade_dados'],
  ['P0001', 'rejeicao_banco'],
  ['__proto__', 'desconhecida'],
  ['SECRET', 'desconhecida'],
]) {
  test(`job classifies ${code} without disclosing the original payload`, async t => {
    fixture.error = Object.assign(new Error('SECRET MESSAGE'), { code, details: 'SECRET DETAIL' })
    const failure = t.mock.method(console, 'error', () => {})
    await assert.rejects(runPaymentReconciliationSweep, actual => actual === fixture.error)
    assert.deepEqual(failure.mock.calls[0].arguments[1].causas, [expected])
    assert.doesNotMatch(JSON.stringify(failure.mock.calls[0].arguments), /SECRET|__proto__/)
  })
}

test('job deduplicates mixed aggregate causes without leaking title details', async t => {
  fixture.error = Object.assign(new AggregateError([
    { code: 'PGRST202', message: 'SECRET TITLE' },
    { code: '55P03', details: 'SECRET ID' },
    { code: '55P03' },
    { code: 'SECRET' },
  ], 'SECRET MESSAGE'), {
    code: 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE',
    resultado: { verificados: 4, quitados: 0, falhas: 4 },
  })
  const failure = t.mock.method(console, 'error', () => {})
  await assert.rejects(runPaymentReconciliationSweep, actual => actual === fixture.error)
  assert.deepEqual(failure.mock.calls[0].arguments[1].causas, ['rpc_indisponivel', 'timeout_lock', 'desconhecida'])
  assert.doesNotMatch(JSON.stringify(failure.mock.calls[0].arguments), /SECRET/)
})

test('empty aggregate emits unknown cause and retains original failure', async t => {
  fixture.error = new AggregateError([], 'SECRET')
  const failure = t.mock.method(console, 'error', () => {})
  await assert.rejects(runPaymentReconciliationSweep, actual => actual === fixture.error)
  assert.deepEqual(failure.mock.calls[0].arguments[1].causas, ['desconhecida'])
})

for (const property of ['code', 'errors', 'resultado']) {
  test(`throwing ${property} getter never replaces the original error`, async t => {
    fixture.error = new Error('SECRET ORIGINAL')
    Object.defineProperty(fixture.error, property, { get() { throw new Error('SECRET GETTER') } })
    const failure = t.mock.method(console, 'error', () => {})
    await assert.rejects(runPaymentReconciliationSweep, actual => actual === fixture.error)
    assert.deepEqual(failure.mock.calls[0].arguments[1], {
      code: 'PAYMENT_RECONCILIATION_FAILURE', causas: ['desconhecida'],
      verificados: null, quitados: null, falhas: null,
    })
    assert.doesNotMatch(JSON.stringify(failure.mock.calls[0].arguments), /SECRET/)
  })
}

test('logger failure never replaces the original sweep error', async t => {
  fixture.error = new Error('SECRET ORIGINAL')
  t.mock.method(console, 'error', () => { throw new Error('SECRET LOGGER') })
  await assert.rejects(runPaymentReconciliationSweep, actual => actual === fixture.error)
})

test('job preserves successful return and does not emit a failure signal', async t => {
  fixture.error = null
  fixture.result = { verificados: 2, quitados: 1 }
  t.mock.method(console, 'log', () => {})
  const failure = t.mock.method(console, 'error', () => {})
  assert.equal(await runPaymentReconciliationSweep(), fixture.result)
  assert.equal(failure.mock.callCount(), 0)
})

test('job emits sanitized partial-failure counters and preserves the original error', async t => {
  fixture.error = Object.assign(new AggregateError([new Error('SECRET TITLE DETAIL')], 'SECRET MESSAGE'), {
    code: 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE',
    resultado: { verificados: 2, quitados: 1, falhas: 1, titulo: 'SECRET ID' },
  })
  const failure = t.mock.method(console, 'error', () => {})
  await assert.rejects(runPaymentReconciliationSweep, actual => actual === fixture.error)
  assert.deepEqual(failure.mock.calls[0].arguments, ['[payment-reconciliation-sweep] falha:', {
    code: 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE', causas: ['desconhecida'], verificados: 2, quitados: 1, falhas: 1,
  }])
  assert.doesNotMatch(JSON.stringify(failure.mock.calls[0].arguments), /SECRET/)
})

test('job never leaks arbitrary error codes, messages or malformed counters', async t => {
  fixture.error = Object.assign(new Error('SECRET'), {
    code: 'SECRET', resultado: { verificados: 'SECRET', quitados: -1, falhas: Infinity },
  })
  const failure = t.mock.method(console, 'error', () => {})
  await assert.rejects(runPaymentReconciliationSweep, actual => actual === fixture.error)
  assert.deepEqual(failure.mock.calls[0].arguments[1], {
    code: 'PAYMENT_RECONCILIATION_FAILURE', causas: ['desconhecida'], verificados: null, quitados: null, falhas: null,
  })
  assert.doesNotMatch(JSON.stringify(failure.mock.calls[0].arguments), /SECRET/)
})
