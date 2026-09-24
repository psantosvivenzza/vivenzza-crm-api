// Regressão do incidente de sobrecarga do Supabase (2026-09): GET
// /api/dashboard/atendimento, pollado a cada 30s por várias abas ao mesmo
// tempo, disparava uma computação pesada completa por poll. Este teste
// prova o mecanismo de coalescimento (single-flight) e cache curto (TTL) de
// forma isolada, sem tocar Postgres nem HTTP — só a lógica do helper.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarCacheComSingleFlight } from '../../../src/lib/singleFlightCache.js'

function adiar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('single-flight: chamadas concorrentes pro mesmo escopo disparam UMA computação só', async () => {
  let chamadas = 0
  const cache = criarCacheComSingleFlight({
    ttlMs: 10000,
    computar: async (escopo) => {
      chamadas++
      await adiar(20)
      return { escopo, chamadaNumero: chamadas }
    },
  })

  const [a, b, c] = await Promise.all([
    cache.obter('vendedor-1', 'vendedor-1'),
    cache.obter('vendedor-1', 'vendedor-1'),
    cache.obter('vendedor-1', 'vendedor-1'),
  ])

  assert.equal(chamadas, 1, 'três chamadas concorrentes pro mesmo escopo deveriam coalescer em 1 execução real')
  assert.deepEqual(a, b)
  assert.deepEqual(b, c)
})

test('escopos diferentes NUNCA coalescem entre si', async () => {
  let chamadas = 0
  const cache = criarCacheComSingleFlight({
    ttlMs: 10000,
    computar: async (escopo) => {
      chamadas++
      await adiar(10)
      return { escopo }
    },
  })

  const [vendedorA, vendedorB] = await Promise.all([
    cache.obter('vendedor-A', 'vendedor-A'),
    cache.obter('vendedor-B', 'vendedor-B'),
  ])

  assert.equal(chamadas, 2, 'escopos diferentes precisam de computação própria, nunca compartilhada')
  assert.equal(vendedorA.escopo, 'vendedor-A')
  assert.equal(vendedorB.escopo, 'vendedor-B')
})

test('cache curto: dentro do TTL, chamada seguinte reaproveita o resultado sem recomputar', async () => {
  let chamadas = 0
  const cache = criarCacheComSingleFlight({
    ttlMs: 200,
    computar: async () => {
      chamadas++
      return { chamadaNumero: chamadas }
    },
  })

  const primeira = await cache.obter('geral', null)
  const segunda = await cache.obter('geral', null)

  assert.equal(chamadas, 1, 'segunda chamada dentro do TTL não deveria recomputar')
  assert.deepEqual(primeira, segunda)
})

test('cache expira: depois do TTL, a próxima chamada recomputa', async () => {
  let chamadas = 0
  const cache = criarCacheComSingleFlight({
    ttlMs: 30,
    computar: async () => {
      chamadas++
      return { chamadaNumero: chamadas }
    },
  })

  await cache.obter('geral', null)
  await adiar(60)
  await cache.obter('geral', null)

  assert.equal(chamadas, 2, 'depois do TTL expirar, a próxima chamada precisa recomputar')
})

test('falha na computação NÃO trava o escopo — próxima chamada tenta de novo', async () => {
  // Espelha a preocupação real documentada em monitoramento-resposta.js
  // (emExecucao): uma falha aqui não pode deixar o escopo permanentemente
  // "em andamento", senão todo poll seguinte pro mesmo escopo ficaria
  // pendurado esperando uma promise que já rejeitou.
  let chamadas = 0
  const cache = criarCacheComSingleFlight({
    ttlMs: 10000,
    computar: async () => {
      chamadas++
      if (chamadas === 1) throw new Error('falha simulada do Supabase')
      return { ok: true }
    },
  })

  await assert.rejects(cache.obter('geral', null), /falha simulada/)
  const resultado = await cache.obter('geral', null)

  assert.equal(chamadas, 2)
  assert.deepEqual(resultado, { ok: true })
})

test('invalidar(chave) força recomputação mesmo dentro do TTL', async () => {
  let chamadas = 0
  const cache = criarCacheComSingleFlight({
    ttlMs: 10000,
    computar: async () => {
      chamadas++
      return { chamadaNumero: chamadas }
    },
  })

  await cache.obter('geral', null)
  cache.invalidar('geral')
  await cache.obter('geral', null)

  assert.equal(chamadas, 2)
})
