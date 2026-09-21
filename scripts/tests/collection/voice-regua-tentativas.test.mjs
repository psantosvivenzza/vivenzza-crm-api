// 2026-09-17 — régua de tentativas de ligação de cobrança (reguaTentativas.js).
// Funções PURAS: sem DB, sem rede, sem Asterisk. Instantes sempre em UTC
// explícito, nunca a hora real da máquina — BRT = UTC-3 fixo (o Brasil não
// observa horário de verão desde 2019).
//
// Prova as cinco travas que protegem o cliente E o nosso número de telefone:
// espaçamento da cadência, rotação de faixa de horário, trava de 7 dias após
// contato efetivo, trava por promessa de pagamento em aberto e o teto de 10
// tentativas por ciclo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  avaliarProximaTentativa,
  faixaDoHorario,
  hashTelefone,
  MAX_TENTATIVAS_CICLO,
} from '../../../src/lib/voice/reguaTentativas.js'

// Quinta-feira, 17/09/2026.
const MANHA = new Date('2026-09-17T13:00:00Z') // 10:00 BRT
const TARDE = new Date('2026-09-17T18:00:00Z') // 15:00 BRT

test('faixa de horário é resolvida em BRT, não no fuso do processo', () => {
  assert.equal(faixaDoHorario(MANHA), 'MANHA')
  assert.equal(faixaDoHorario(TARDE), 'TARDE')
  // 06:00 BRT está fora de qualquer faixa operacional.
  assert.equal(faixaDoHorario(new Date('2026-09-17T09:00:00Z')), 'FORA_DE_FAIXA')
})

test('telefone sem histórico libera a tentativa 1 e abre ciclo', () => {
  const r = avaliarProximaTentativa({ historico: [], agora: MANHA })
  assert.equal(r.permitido, true)
  assert.equal(r.tentativaNumero, 1)
  assert.equal(r.cicloNovo, true)
  assert.equal(r.cicloIniciadoEm, '2026-09-17')
})

test('espaçamento: tentativa 2 está prevista para D+1 e não sai em D+0', () => {
  const r = avaliarProximaTentativa({
    historico: [{ criadoEm: '2026-09-17T12:00:00Z', faixaHorario: 'MANHA', cicloIniciadoEm: '2026-09-17', atendida: false }],
    agora: TARDE,
  })
  assert.equal(r.permitido, false)
  assert.match(r.motivo, /^cedo_demais/)
})

test('rotação: duas tentativas seguidas nunca caem na mesma faixa do dia', () => {
  const r = avaliarProximaTentativa({
    historico: [{ criadoEm: '2026-09-17T18:00:00Z', faixaHorario: 'TARDE', cicloIniciadoEm: '2026-09-17', atendida: false }],
    agora: new Date('2026-09-18T18:00:00Z'), // D+1, também TARDE
  })
  assert.equal(r.permitido, false)
  assert.match(r.motivo, /^mesma_faixa_da_anterior/)
})

test('cadência cumprida em faixa diferente libera a próxima tentativa', () => {
  const r = avaliarProximaTentativa({
    historico: [{ criadoEm: '2026-09-17T12:00:00Z', faixaHorario: 'MANHA', cicloIniciadoEm: '2026-09-17', atendida: false }],
    agora: new Date('2026-09-18T18:00:00Z'), // D+1, TARDE
  })
  assert.equal(r.permitido, true)
  assert.equal(r.tentativaNumero, 2)
})

test('contato efetivo trava o ciclo por 7 dias', () => {
  const r = avaliarProximaTentativa({
    historico: [{ criadoEm: '2026-09-16T13:00:00Z', faixaHorario: 'MANHA', cicloIniciadoEm: '2026-09-16', atendida: true }],
    agora: TARDE,
  })
  assert.equal(r.permitido, false)
  assert.match(r.motivo, /^trava_pos_contato/)
})

test('promessa de pagamento em aberto trava até a data prometida', () => {
  const r = avaliarProximaTentativa({
    historico: [{
      criadoEm: '2026-09-10T13:00:00Z', faixaHorario: 'MANHA', cicloIniciadoEm: '2026-09-10',
      atendida: true, dataPrometida: '2026-09-25',
    }],
    agora: TARDE,
  })
  assert.equal(r.permitido, false)
  assert.match(r.motivo, /^promessa_em_aberto/)
  assert.equal(r.proximaTentativaEm, '2026-09-25')
})

test(`teto de ${MAX_TENTATIVAS_CICLO} tentativas por ciclo é fail-closed`, () => {
  const dez = Array.from({ length: MAX_TENTATIVAS_CICLO }, (_, i) => ({
    criadoEm: `2026-09-0${(i % 9) + 1}T13:00:00Z`,
    faixaHorario: 'MANHA',
    cicloIniciadoEm: '2026-09-01',
    atendida: false,
  }))
  const r = avaliarProximaTentativa({ historico: dez, agora: new Date('2026-09-20T18:00:00Z') })
  assert.equal(r.permitido, false)
  assert.match(r.motivo, /^ciclo_esgotado/)
})

test('ciclo com mais de 30 dias expira e recomeça na tentativa 1', () => {
  const dez = Array.from({ length: MAX_TENTATIVAS_CICLO }, (_, i) => ({
    criadoEm: `2026-09-0${(i % 9) + 1}T13:00:00Z`,
    faixaHorario: 'MANHA',
    cicloIniciadoEm: '2026-09-01',
    atendida: false,
  }))
  const r = avaliarProximaTentativa({ historico: dez, agora: new Date('2026-11-20T18:00:00Z') })
  assert.equal(r.permitido, true)
  assert.equal(r.tentativaNumero, 1)
  assert.equal(r.cicloNovo, true)
})

test('hash de telefone normaliza formatos e nunca expõe o número', () => {
  const a = hashTelefone('+5551991567661')
  const b = hashTelefone('51991567661')
  const c = hashTelefone('(51) 99156-7661')
  assert.equal(a, b)
  assert.equal(b, c)
  assert.ok(!String(a).includes('991567661'))
  assert.equal(hashTelefone(''), null)
})
