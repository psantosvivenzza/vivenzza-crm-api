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
    code: 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE', verificados: 2, quitados: 1, falhas: 1,
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
    code: 'PAYMENT_RECONCILIATION_FAILURE', verificados: null, quitados: null, falhas: null,
  })
  assert.doesNotMatch(JSON.stringify(failure.mock.calls[0].arguments), /SECRET/)
})
