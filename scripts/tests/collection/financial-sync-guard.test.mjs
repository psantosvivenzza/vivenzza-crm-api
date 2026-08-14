// Guard de frescor do sync financeiro — decisão pura (allowed/reason),
// contra o CÓDIGO REAL (financialSyncGuard.js) e Postgres local. Cenários
// obrigatórios 1-7 do pedido de 2026-08-14.
import { test, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, verificarFrescorSync, _resetCacheParaTeste

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ verificarFrescorSync, _resetCacheParaTeste } = await import('../../../src/lib/collection/financialSyncGuard.js'))
})
after(async () => { await pararAmbienteDeTeste() })

async function limparSincronizacoes() {
  await supabase.from('sincronizacoes_financeiro').delete().eq('dry_run', false)
}

async function inserirSync({ status = 'concluido', minutosAtras = 1, totalComErro = 0, semConcluidoEm = false }) {
  const concluidoEm = new Date(Date.now() - minutosAtras * 60000).toISOString()
  const { error } = await supabase.from('sincronizacoes_financeiro').insert({
    status, dry_run: false, iniciado_em: concluidoEm,
    concluido_em: semConcluidoEm ? null : concluidoEm,
    total_lido: 1, total_atualizado: 0, total_sem_alteracao: 0, total_sem_match: 0,
    total_conflito: 0, total_cancelado: 0, total_com_erro: totalComErro,
  })
  if (error) throw error
}

beforeEach(async () => {
  await limparSincronizacoes()
  _resetCacheParaTeste()
  delete process.env.COBRANCA_EXIGE_SYNC
  delete process.env.COBRANCA_SYNC_MAX_ATRASO_MIN
})

test('1. sync fresco -> permite', async () => {
  await inserirSync({ minutosAtras: 5 })
  const r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, true)
  assert.equal(r.reason, null)
  assert.equal(r.age_minutes, 5)
})

test('2. sync velho (>240min default) -> bloqueia', async () => {
  await inserirSync({ minutosAtras: 300 })
  const r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'sync_stale')
  assert.equal(r.age_minutes, 300)
})

test('3. nunca sincronizou -> bloqueia', async () => {
  // limparSincronizacoes já rodou no beforeEach — tabela sem linha dry_run=false
  const r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'nunca_sincronizou')
})

test('4. consulta ao banco falha -> bloqueia (client injetado)', async () => {
  const clienteQuebrado = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'conexão recusada' } }) }) }) }) }) }) }
  const r = await verificarFrescorSync({ ignorarCache: true, clienteSupabase: clienteQuebrado })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'erro_consulta_banco')
})

test('5. último ciclo inválido/com erro -> bloqueia (falhou, executando, com_erros)', async () => {
  await inserirSync({ status: 'falhou', minutosAtras: 2 })
  let r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'ultimo_sync_falhou')

  await limparSincronizacoes()
  await inserirSync({ status: 'executando', minutosAtras: 0, semConcluidoEm: true })
  r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'ultimo_sync_em_andamento')

  await limparSincronizacoes()
  await inserirSync({ status: 'concluido_com_erros', minutosAtras: 2, totalComErro: 3 })
  r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'ultimo_sync_com_erros')
})

test('6. env COBRANCA_EXIGE_SYNC ausente -> default seguro (true, continua exigindo)', async () => {
  delete process.env.COBRANCA_EXIGE_SYNC
  // nenhum sync -> se o default fosse "desligado", isso passaria; deve bloquear
  const r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, false)
  assert.equal(r.reason, 'nunca_sincronizou')
})

test('6b. env COBRANCA_EXIGE_SYNC="false" -> desliga o guard de propósito', async () => {
  process.env.COBRANCA_EXIGE_SYNC = 'false'
  const r = await verificarFrescorSync({ ignorarCache: true })
  assert.equal(r.allowed, true)
  assert.equal(r.reason, 'guard_desabilitado')
})

test('7. COBRANCA_SYNC_MAX_ATRASO_MIN inválido/ausente -> default seguro (240)', async () => {
  await inserirSync({ minutosAtras: 250 }) // > 240 (default) mas seria "fresco" com um limite maior
  for (const valorInvalido of [undefined, '0', '-10', 'abc', '']) {
    if (valorInvalido === undefined) delete process.env.COBRANCA_SYNC_MAX_ATRASO_MIN
    else process.env.COBRANCA_SYNC_MAX_ATRASO_MIN = valorInvalido
    const r = await verificarFrescorSync({ ignorarCache: true })
    assert.equal(r.max_age_minutes, 240, `valor "${valorInvalido}" deveria cair no default 240`)
    assert.equal(r.allowed, false, `250min > 240 default deveria bloquear com max_atraso="${valorInvalido}"`)
  }
})

test('cache: 2 chamadas em sequência sem ignorarCache não repetem a consulta (mesmo resultado, reflete o mesmo instante)', async () => {
  await inserirSync({ minutosAtras: 1 })
  const r1 = await verificarFrescorSync()
  const r2 = await verificarFrescorSync()
  assert.deepEqual(r1, r2)
})
