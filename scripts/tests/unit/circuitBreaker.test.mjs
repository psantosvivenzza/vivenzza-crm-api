// Regressão do incidente de sobrecarga do Supabase (2026-09-28, Cloudflare
// 522 no host + latências de 90-300s): prova o mecanismo de circuit breaker
// (src/lib/circuitBreaker.js) de forma isolada, sem tocar Postgres nem HTTP
// — só a máquina de estados. Ver scripts/tests/leads-supabase-cascade-20260928.test.mjs
// para a integração de verdade contra Postgres local (timeout real via
// .abortSignal + breaker gating em src/routes/leads.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarCircuitBreaker, CircuitBreakerAbertoError } from '../../../src/lib/circuitBreaker.js'

function adiar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('circuito fechado: sucesso não abre nada, chamadas continuam passando', async () => {
  const breaker = criarCircuitBreaker({ chave: 'teste', falhasParaAbrir: 3, cooldownMs: 50 })
  const r1 = await breaker.executar(async () => 'ok-1')
  const r2 = await breaker.executar(async () => 'ok-2')
  assert.equal(r1, 'ok-1')
  assert.equal(r2, 'ok-2')
  assert.equal(breaker.estadoAtual().estado, 'fechado')
})

test('abre depois de N falhas consecutivas e passa a rejeitar sem executar fn', async () => {
  const breaker = criarCircuitBreaker({ chave: 'teste', falhasParaAbrir: 3, cooldownMs: 10000 })
  let chamadasReais = 0
  const falhar = async () => { chamadasReais++; throw new Error('falha simulada do Supabase') }

  await assert.rejects(breaker.executar(falhar), /falha simulada/)
  await assert.rejects(breaker.executar(falhar), /falha simulada/)
  assert.equal(breaker.estadoAtual().estado, 'fechado', 'ainda não bateu o limiar')
  await assert.rejects(breaker.executar(falhar), /falha simulada/)
  assert.equal(breaker.estadoAtual().estado, 'aberto', 'terceira falha consecutiva deveria abrir o circuito')
  assert.equal(chamadasReais, 3)

  // Circuito aberto: a 4ª chamada NUNCA deveria tocar fn — rejeita na hora.
  await assert.rejects(breaker.executar(falhar), CircuitBreakerAbertoError)
  assert.equal(chamadasReais, 3, 'chamada com circuito aberto não deveria executar fn')
})

test('sucesso intercalado reseta o contador de falhas consecutivas — não abre por falhas não-consecutivas', async () => {
  const breaker = criarCircuitBreaker({ chave: 'teste', falhasParaAbrir: 3, cooldownMs: 10000 })
  const falhar = async () => { throw new Error('falha') }
  const sucesso = async () => 'ok'

  await assert.rejects(breaker.executar(falhar))
  await assert.rejects(breaker.executar(falhar))
  await breaker.executar(sucesso) // reseta o contador antes de bater o limiar
  await assert.rejects(breaker.executar(falhar))
  await assert.rejects(breaker.executar(falhar))

  assert.equal(breaker.estadoAtual().estado, 'fechado', 'falhas intercaladas por sucesso nunca deveriam somar pro limiar')
})

test('depois do cooldown, permite exatamente 1 chamada de teste (meio-aberto)', async () => {
  const breaker = criarCircuitBreaker({ chave: 'teste', falhasParaAbrir: 1, cooldownMs: 30 })
  await assert.rejects(breaker.executar(async () => { throw new Error('falha') }))
  assert.equal(breaker.estadoAtual().estado, 'aberto')

  // Ainda dentro do cooldown — rejeita sem executar.
  let chamouDuranteCooldown = false
  await assert.rejects(breaker.executar(async () => { chamouDuranteCooldown = true }), CircuitBreakerAbertoError)
  assert.equal(chamouDuranteCooldown, false)

  await adiar(40) // cooldown passou

  let chamouDepoisDoCooldown = false
  const resultado = await breaker.executar(async () => { chamouDepoisDoCooldown = true; return 'recuperado' })
  assert.equal(chamouDepoisDoCooldown, true, 'depois do cooldown, a chamada de teste deveria executar fn de verdade')
  assert.equal(resultado, 'recuperado')
  assert.equal(breaker.estadoAtual().estado, 'fechado', 'sucesso na prova meio-aberta deveria fechar o circuito')
})

test('prova meio-aberta que falha reabre o circuito com backoff exponencial (cooldown maior)', async () => {
  const breaker = criarCircuitBreaker({ chave: 'teste', falhasParaAbrir: 1, cooldownMs: 30, cooldownMaxMs: 1000 })
  await assert.rejects(breaker.executar(async () => { throw new Error('falha 1') }))
  const cooldownInicial = breaker.estadoAtual().cooldownAtualMs

  await adiar(40) // cooldown passou, entra em meio-aberto

  await assert.rejects(breaker.executar(async () => { throw new Error('falha na prova') }))
  const estado = breaker.estadoAtual()
  assert.equal(estado.estado, 'aberto', 'prova que falha deveria reabrir o circuito')
  assert.equal(estado.cooldownAtualMs, cooldownInicial * 2, 'cooldown deveria dobrar depois de uma prova falha')
})

test('backoff exponencial respeita o teto (cooldownMaxMs) e não cresce indefinidamente', async () => {
  const breaker = criarCircuitBreaker({ chave: 'teste', falhasParaAbrir: 1, cooldownMs: 10, cooldownMaxMs: 35 })
  const falhar = async () => { throw new Error('falha') }

  await assert.rejects(breaker.executar(falhar)) // abre, cooldown=10
  await adiar(15)
  await assert.rejects(breaker.executar(falhar)) // prova falha, cooldown=20
  await adiar(25)
  await assert.rejects(breaker.executar(falhar)) // prova falha, cooldown=min(40,35)=35
  assert.equal(breaker.estadoAtual().cooldownAtualMs, 35)
  await adiar(40)
  await assert.rejects(breaker.executar(falhar)) // prova falha, cooldown=min(70,35)=35 — nunca passa do teto
  assert.equal(breaker.estadoAtual().cooldownAtualMs, 35)
})

test('chamadas concorrentes durante a janela meio-aberta: só UMA executa fn, as demais rejeitam rápido', async () => {
  const breaker = criarCircuitBreaker({ chave: 'teste', falhasParaAbrir: 1, cooldownMs: 20 })
  await assert.rejects(breaker.executar(async () => { throw new Error('falha') }))
  await adiar(30) // cooldown passou

  let execucoesReais = 0
  const fnLenta = async () => {
    execucoesReais++
    await adiar(30)
    return 'ok'
  }

  const resultados = await Promise.allSettled([
    breaker.executar(fnLenta),
    breaker.executar(fnLenta),
    breaker.executar(fnLenta),
  ])

  assert.equal(execucoesReais, 1, 'só a primeira chamada concorrente deveria ganhar o slot de prova meio-aberta')
  const cumpridas = resultados.filter((r) => r.status === 'fulfilled')
  const rejeitadas = resultados.filter((r) => r.status === 'rejected')
  assert.equal(cumpridas.length, 1)
  assert.equal(rejeitadas.length, 2)
  for (const r of rejeitadas) assert.ok(r.reason instanceof CircuitBreakerAbertoError)
})

test('CircuitBreakerAbertoError carrega a chave e um retryAposMs coerente com o cooldown restante', async () => {
  const breaker = criarCircuitBreaker({ chave: 'leads-teste', falhasParaAbrir: 1, cooldownMs: 5000 })
  await assert.rejects(breaker.executar(async () => { throw new Error('falha') }))

  try {
    await breaker.executar(async () => 'nunca deveria rodar')
    assert.fail('deveria ter rejeitado com circuito aberto')
  } catch (err) {
    assert.ok(err instanceof CircuitBreakerAbertoError)
    assert.equal(err.chave, 'leads-teste')
    assert.ok(err.retryAposMs > 0 && err.retryAposMs <= 5000, `retryAposMs (${err.retryAposMs}) deveria estar entre 0 e o cooldown configurado`)
  }
})
