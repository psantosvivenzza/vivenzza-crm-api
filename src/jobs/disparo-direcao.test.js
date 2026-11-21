import test from 'node:test'
import assert from 'node:assert/strict'
import { dentroDaJanela, proximoIntervaloMs, inicioDoDiaBRT } from './disparo-direcao.js'

test('janela: seg-sáb 09:00-17:30 de Brasília', () => {
  assert.equal(dentroDaJanela(new Date('2026-11-23T13:00:00Z')), true) // seg 10:00 BRT
  assert.equal(dentroDaJanela(new Date('2026-11-23T11:30:00Z')), false) // seg 08:30 BRT
  assert.equal(dentroDaJanela(new Date('2026-11-23T21:00:00Z')), false) // seg 18:00 BRT
  assert.equal(dentroDaJanela(new Date('2026-11-21T15:00:00Z')), true) // sábado 12:00 BRT
  assert.equal(dentroDaJanela(new Date('2026-11-22T15:00:00Z')), false) // domingo
})

test('intervalo fica entre 2 e 4 minutos', () => {
  assert.equal(proximoIntervaloMs(120, 240, () => 0), 120000)
  assert.equal(proximoIntervaloMs(120, 240, () => 1), 240000)
  const v = proximoIntervaloMs(120, 240)
  assert.ok(v >= 120000 && v <= 240000)
})

test('intervalo nunca abaixo de 30s mesmo com config errada', () => {
  assert.equal(proximoIntervaloMs(1, 2, () => 0), 30000)
})

test('inicio do dia em BRT', () => {
  assert.equal(inicioDoDiaBRT(new Date('2026-11-23T02:00:00Z')).toISOString(), '2026-11-22T03:00:00.000Z')
})
