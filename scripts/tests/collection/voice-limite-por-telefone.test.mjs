// 2026-09-17 — regressão do bug encontrado no primeiro lote real de fila:
// buscarEstadoChamadasExternas() etiquetava TODAS as ligações do dia com o
// número que estava sendo avaliado. Como avaliarLimiteDiarioPorTelefone()
// conta as entradas cujo `numero` bate, bastava UMA ligação qualquer ter saído
// no dia para o limite por telefone (1/dia) bloquear TODA a fila.
//
// Aqui testamos a função pura de limite com as duas formas de lista — a
// correta (só o próprio telefone etiquetado) e a incorreta (tudo etiquetado) —
// para deixar explícito por que a diferença importa.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  avaliarLimiteDiarioPorTelefone,
  avaliarLimiteGlobalPorDia,
  avaliarLimiteGlobalPorHora,
} from '../../../src/lib/voice/externalPilotGuardrails.js'

const ALVO = '+5551994112439'
const OUTRO = '+5551991567661'

test('ligação para OUTRO cliente não consome o limite diário deste telefone', () => {
  // Como o repositório monta a lista DEPOIS da correção: só a ligação que
  // realmente foi para este telefone leva o número; as demais vêm com null.
  const chamadasHoje = [
    { numero: null, criadoEm: '2026-09-17T18:26:58Z' }, // foi para outro cliente
    { numero: null, criadoEm: '2026-09-17T18:10:00Z' }, // idem
  ]
  assert.equal(
    avaliarLimiteDiarioPorTelefone(ALVO, chamadasHoje, 1),
    true,
    'com limite de 1/dia e nenhuma ligação para ESTE telefone, tem que liberar',
  )
})

test('segunda ligação para o MESMO telefone no dia é bloqueada', () => {
  const chamadasHoje = [
    { numero: ALVO, criadoEm: '2026-09-17T18:26:58Z' },
    { numero: null, criadoEm: '2026-09-17T18:10:00Z' },
  ]
  assert.equal(avaliarLimiteDiarioPorTelefone(ALVO, chamadasHoje, 1), false)
  // e continua liberando para um telefone diferente
  assert.equal(avaliarLimiteDiarioPorTelefone(OUTRO, chamadasHoje, 1), true)
})

test('o bug antigo, reproduzido: etiquetar tudo com o mesmo número trava a fila', () => {
  const comoEraAntes = [
    { numero: ALVO, criadoEm: '2026-09-17T18:26:58Z' }, // na verdade foi para outro cliente
  ]
  assert.equal(
    avaliarLimiteDiarioPorTelefone(ALVO, comoEraAntes, 1),
    false,
    'é exatamente assim que a fila inteira era bloqueada após a primeira ligação do dia',
  )
})

test('os tetos GLOBAIS continuam contando todas as ligações, independente do telefone', () => {
  const todasDoDia = [
    { numero: ALVO, criadoEm: '2026-09-17T18:26:58Z' },
    { numero: null, criadoEm: '2026-09-17T18:10:00Z' },
    { numero: null, criadoEm: '2026-09-17T17:55:00Z' },
  ]
  assert.equal(avaliarLimiteGlobalPorDia(todasDoDia, 40), true, '3 de 40 no dia')
  assert.equal(avaliarLimiteGlobalPorDia(todasDoDia, 3), false, 'teto de 3 atingido')
  assert.equal(avaliarLimiteGlobalPorHora(todasDoDia, 8), true, '3 de 8 na hora')
  assert.equal(avaliarLimiteGlobalPorHora(todasDoDia, 3), false, 'teto de 3/hora atingido')
})
