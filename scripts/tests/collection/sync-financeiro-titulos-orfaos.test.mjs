// ACHADO 2026-10-05 — cliente Renan Rodrigues Freitas pagou e a régua seguia
// cobrando: o NetVision APAGA as parcelas ao refazer um parcelamento (títulos
// 1009177/1009178 viraram 1009179/1009180) e o CRM deixava as antigas `aberta`
// pra sempre. identificarTitulosOrfaos() é a regra que fecha esse buraco —
// função pura, sem rede/banco. Este arquivo prova a regra E cada trava.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  identificarTitulosOrfaos, ORFAO_LIMITE_POR_CICLO, ORFAO_MIN_LINHAS_ERP,
} from '../../../src/lib/financeiroLegado.js'

const ANTIGO = '2026-08-19T12:00:00Z'

function titulo(n, seq, extra = {}) {
  return {
    id: `id-${n}-${seq}`, legacy_id: `cr-${n}-${seq}`, status: 'aberta', valor: 186.53, valor_pago: 0,
    codigo_cliente: '000947', vencimento: '2026-09-19', created_at: ANTIGO, ...extra,
  }
}

// ERP "saudável": N títulos presentes (preenche o piso de plausibilidade).
function erpCom(chaves, total = ORFAO_MIN_LINHAS_ERP + 500) {
  return { chavesNoErp: new Set(chaves), linhasLidasErp: total }
}

test('identificarTitulosOrfaos', async (t) => {
  await t.test('1. caso Renan: parcelas que sumiram do ERP são canceladas', () => {
    const contas = [titulo(1009177, 1), titulo(1009177, 2), titulo(1009178, 1)]
    const r = identificarTitulosOrfaos({ contasCrm: contas, ...erpCom(['cr-1009179-1']), varreduraCompleta: true })
    assert.equal(r.aplicavel, true)
    assert.equal(r.cancelar.length, 3)
    assert.equal(r.revisar.length, 0)
  })

  await t.test('2. título que o ERP ainda tem NÃO é órfão (qualquer prefixo)', () => {
    const contas = [titulo(1009310, 1), { ...titulo(1009310, 2), legacy_id: '001-1009310-2' }]
    const r = identificarTitulosOrfaos({
      contasCrm: contas, ...erpCom(['cr-1009310-1', 'cr-1009310-2', '001-1009310-1', '001-1009310-2']), varreduraCompleta: true,
    })
    assert.equal(r.cancelar.length, 0)
  })

  await t.test('3. mesmo título com o outro prefixo no ERP -> não é órfão', () => {
    const r = identificarTitulosOrfaos({
      contasCrm: [titulo(1008863, 4)], ...erpCom(['001-1008863-4']), varreduraCompleta: true,
    })
    assert.equal(r.cancelar.length, 0)
  })

  await t.test('4. leitura incremental nunca decide órfão', () => {
    const r = identificarTitulosOrfaos({ contasCrm: [titulo(1, 1)], ...erpCom([]), varreduraCompleta: false })
    assert.equal(r.aplicavel, false)
    assert.equal(r.motivo, 'incremental')
    assert.equal(r.cancelar.length, 0)
  })

  await t.test('5. leitura do ERP implausível (e01 devolveu quase nada) -> nada é apagado', () => {
    const r = identificarTitulosOrfaos({ contasCrm: [titulo(1, 1)], chavesNoErp: new Set(), linhasLidasErp: 12, varreduraCompleta: true })
    assert.equal(r.aplicavel, false)
    assert.match(r.motivo, /implausível/)
    assert.equal(r.cancelar.length, 0)
  })

  await t.test('6. pagamento parcial -> revisão, nunca cancelamento', () => {
    const r = identificarTitulosOrfaos({
      contasCrm: [titulo(5, 1, { status: 'pago_parcial', valor_pago: 50 })], ...erpCom([]), varreduraCompleta: true,
    })
    assert.equal(r.aplicavel, true)
    assert.equal(r.cancelar.length, 0)
    assert.equal(r.revisar.length, 1)
  })

  await t.test('7. título já pago/cancelado não é tocado', () => {
    const contas = [titulo(6, 1, { status: 'paga' }), titulo(6, 2, { status: 'cancelada' })]
    const r = identificarTitulosOrfaos({ contasCrm: contas, ...erpCom([]), varreduraCompleta: true })
    assert.equal(r.cancelar.length + r.revisar.length, 0)
  })

  await t.test('8. sem codigo_cliente (não é cobrança de cliente) -> ignorado', () => {
    const r = identificarTitulosOrfaos({
      contasCrm: [titulo(7, 1, { codigo_cliente: null }), titulo(7, 2, { codigo_cliente: '  ' })], ...erpCom([]), varreduraCompleta: true,
    })
    assert.equal(r.cancelar.length, 0)
  })

  await t.test('9. título de outra origem (e99-, manual) não é tratado', () => {
    const contas = [
      { ...titulo(8, 1), legacy_id: 'e99-8-1' },
      { ...titulo(8, 2), legacy_id: 'manual-abc' },
    ]
    const r = identificarTitulosOrfaos({ contasCrm: contas, ...erpCom([]), varreduraCompleta: true })
    assert.equal(r.cancelar.length, 0)
  })

  await t.test('10. título criado há menos de 2 dias é poupado (corrida com a criação)', () => {
    const r = identificarTitulosOrfaos({
      contasCrm: [titulo(9, 1, { created_at: new Date().toISOString() })], ...erpCom([]), varreduraCompleta: true,
    })
    assert.equal(r.cancelar.length, 0)
  })

  await t.test('11. acima do teto por ciclo -> anomalia, NADA aplicado', () => {
    const muitos = Array.from({ length: ORFAO_LIMITE_POR_CICLO + 1 }, (_, i) => titulo(2000000 + i, 1))
    const r = identificarTitulosOrfaos({ contasCrm: muitos, ...erpCom([], 200000), varreduraCompleta: true })
    assert.equal(r.aplicavel, false)
    assert.match(r.motivo, /teto/)
  })

  await t.test('12. sem vencimento -> não decide', () => {
    const r = identificarTitulosOrfaos({
      contasCrm: [titulo(10, 1, { vencimento: null })], ...erpCom([]), varreduraCompleta: true,
    })
    assert.equal(r.cancelar.length, 0)
  })
})
