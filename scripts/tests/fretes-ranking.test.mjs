import test from 'node:test'
import assert from 'node:assert/strict'
import { validarProposta, compararPropostas } from '../../src/lib/fretes/domain.js'
const proposta = (id, valor_total, prazo_dias, extra = {}) => ({ id, valor_total, prazo_dias, completa: true, status: 'recebida', validade: '2030-01-01T00:00:00Z', ...extra })

test('ranking ignora preços não finitos ou convertidos de tipos não numéricos', () => {
 for (const valor of [Infinity, 'Infinity', '1e999', true, [], [2], {}, ' ', 0, -1, NaN, null, 1e308, 1e9 + 0.01]) {
  const c = compararPropostas([proposta('invalida', valor, 0), proposta('valida', 100, 2)], {}, new Date('2026-10-18T12:00:00Z'))
  assert.equal(c.quantidade_completas, 1)
  assert.equal(c.menor_valor.id, 'valida')
  assert.equal(c.menor_prazo.id, 'valida')
  assert.equal(c.media_valor, 100)
 }
})

test('ranking ignora prazos não numéricos e preserva números decimais em strings', () => {
 for (const prazo of [false, true, ' ', [], [1], {}, Infinity, 'Infinity', '1.5']) {
  const c = compararPropostas([proposta('invalida', 1, prazo), proposta('valida', '100.50', '0')], {}, new Date('2026-10-18T12:00:00Z'))
  assert.equal(c.quantidade_completas, 1)
  assert.equal(c.melhor_custo_beneficio.id, 'valida')
  assert.equal(c.media_valor, 100.5)
  assert.equal(c.menor_prazo.prazo_dias, 0)
 }
})

test('ranking preserva o teto de preço já aceito pela validação de proposta', () => {
 const validada = validarProposta({valor_total:'1000000000',prazo_dias:1,completa:true,validade:'2030-01-01T00:00:00Z'})
 assert.equal(validada.valor_total, 1e9)
 const c = compararPropostas([proposta('limite', '1000000000', 1)], {}, new Date('2026-10-18T12:00:00Z'))
 assert.equal(c.quantidade_completas, 1)
 assert.equal(c.menor_valor.valor_total, 1e9)
 assert.equal(c.media_valor, 1e9)
})

