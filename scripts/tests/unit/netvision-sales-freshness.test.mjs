import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// Única fronteira substituída: cliente administrativo. Nenhum .env/banco/rede.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('/supabase-admin.server.js')) return { shortCircuit: true,
    url: 'data:text/javascript,export const supabase={from(){throw new Error("Default database forbidden in synthetic test")}}' }
  return next(specifier, context)
} })
const { verificarStatusSyncFiscal } = await import('../../../src/lib/vendaFiscalSyncStatus.js')
const { verificarStatusSyncGerencial } = await import('../../../src/lib/vendaGerencialSyncStatus.js')
const NOW = Date.parse('2026-10-15T15:00:00.000Z')
const sync = (extra = {}, ageMs = 60000) => ({ status: 'concluido', total_com_erro: 0,
  iniciado_em: new Date(NOW - 120000).toISOString(), concluido_em: new Date(NOW - ageMs).toISOString(), ...extra })

for (const [domain, verify, table, env] of [
  ['fiscal', verificarStatusSyncFiscal, 'sincronizacoes_fiscal', 'VENDAS_FISCAIS_SYNC_MAX_ATRASO_MIN'],
  ['gerencial', verificarStatusSyncGerencial, 'sincronizacoes_vendas_gerenciais', 'VENDAS_GERENCIAIS_SYNC_MAX_ATRASO_MIN'],
]) {
  function setup(t) {
    t.mock.method(Date, 'now', () => NOW)
    const previous = process.env[env]; delete process.env[env]
    t.after(() => { if (previous === undefined) delete process.env[env]; else process.env[env] = previous })
  }
  function client(data, error = null, trace = []) {
    const c = {}
    for (const method of ['from', 'select', 'eq', 'order', 'limit']) c[method] = (...args) => { trace.push([method, ...args]); return c }
    c.maybeSingle = async () => ({ data, error })
    return c
  }
  async function expectUnavailable(data, reason) {
    const r = await verify({ clienteSupabase: client(data) })
    assert.equal(r.disponivel, false); assert.equal(r.reason, reason); return r
  }
  test(`${domain}: sucesso fresco preserva contrato e consulta exclusiva sem dry-run`, async (t) => {
    setup(t); const trace = [], row = sync()
    const r = await verify({ clienteSupabase: client(row, null, trace) })
    assert.deepEqual(r, { disponivel: true, reason: null, last_sync_at: row.concluido_em, age_minutes: 1, max_age_minutes: 1440 })
    assert.deepEqual(trace, [['from', table], ['select', 'status, iniciado_em, concluido_em, total_com_erro'], ['eq', 'dry_run', false], ['order', 'iniciado_em', { ascending: false }], ['limit', 1]])
  })
  test(`${domain}: sem histórico não inventa zero confirmado`, async (t) => { setup(t); await expectUnavailable(null, 'nunca_sincronizou') })
  test(`${domain}: erro retornado bloqueia`, async (t) => {
    setup(t); assert.equal((await verify({ clienteSupabase: client(null, { code: 'SYNTHETIC' }) })).reason, 'erro_consulta_banco')
  })
  test(`${domain}: exceção bloqueia`, async (t) => {
    setup(t); assert.equal((await verify({ clienteSupabase: { from() { throw Error('synthetic') } } })).reason, 'erro_consulta_banco')
  })
  test(`${domain}: falhou preserva motivo`, async (t) => { setup(t); await expectUnavailable(sync({ status: 'falhou' }), 'ultimo_sync_falhou') })
  test(`${domain}: falhou sem conclusão preserva timestamp de início`, async (t) => {
    setup(t); const row = sync({ status: 'falhou', concluido_em: null })
    const r = await expectUnavailable(row, 'ultimo_sync_falhou'); assert.equal(r.last_sync_at, row.iniciado_em)
  })
  test(`${domain}: executando preserva motivo`, async (t) => { setup(t); await expectUnavailable(sync({ status: 'executando' }), 'ultimo_sync_em_andamento') })
  test(`${domain}: contador positivo impede sucesso`, async (t) => { setup(t); await expectUnavailable(sync({ total_com_erro: 3 }), 'ultimo_sync_com_erros') })
  test(`${domain}: concluido_com_erros bloqueia mesmo com contador zero`, async (t) => {
    setup(t); await expectUnavailable(sync({ status: 'concluido_com_erros', total_com_erro: 0 }), 'ultimo_sync_com_erros')
  })
  test(`${domain}: status desconhecido nunca prova sucesso`, async (t) => {
    setup(t); for (const status of [null, undefined, '', 'cancelado', 'concluido_parcial', 'CONCLUIDO']) await expectUnavailable(sync({ status }), 'ultimo_sync_status_invalido')
  })
  test(`${domain}: sem conclusão bloqueia`, async (t) => { setup(t); await expectUnavailable(sync({ concluido_em: null }), 'ultimo_sync_sem_timestamp_conclusao') })
  test(`${domain}: timestamp inválido bloqueia`, async (t) => { setup(t); await expectUnavailable(sync({ concluido_em: 'invalid' }), 'timestamp_invalido') })
  for (const futureMs of [1, 29000, 120000]) test(`${domain}: conclusão futura +${futureMs}ms bloqueia antes de arredondar`, async (t) => {
    setup(t); const row = sync({}, -futureMs)
    const r = await expectUnavailable(row, 'timestamp_futuro'); assert.equal(r.last_sync_at, row.concluido_em); assert.equal(r.age_minutes, null)
  })
  test(`${domain}: conclusão exatamente agora é válida`, async (t) => { setup(t); assert.equal((await verify({ clienteSupabase: client(sync({}, 0)) })).disponivel, true) })
  test(`${domain}: antigo permanece indisponível`, async (t) => { setup(t); await expectUnavailable(sync({}, 1500 * 60000), 'sync_desatualizado') })
  test(`${domain}: limite exato continua permitido`, async (t) => { setup(t); assert.equal((await verify({ clienteSupabase: client(sync({}, 1440 * 60000)) })).disponivel, true) })
  test(`${domain}: arredondamento de expiração permanece como antes`, async (t) => {
    setup(t)
    assert.equal((await verify({ clienteSupabase: client(sync({}, 1440 * 60000 + 29999)) })).disponivel, true)
    const r = await expectUnavailable(sync({}, 1440 * 60000 + 30000), 'sync_desatualizado'); assert.equal(r.age_minutes, 1441)
  })
  test(`${domain}: limite customizado não é alterado`, async (t) => { setup(t); process.env[env] = '5'; const r = await expectUnavailable(sync({}, 6 * 60000), 'sync_desatualizado'); assert.equal(r.max_age_minutes, 5) })
  test(`${domain}: configuração inválida mantém default`, async (t) => {
    setup(t); for (const value of ['0', '-1', 'abc', '', 'Infinity']) {
      process.env[env] = value
      const r = await expectUnavailable(sync({}, 1450 * 60000), 'sync_desatualizado'); assert.equal(r.max_age_minutes, 1440)
    }
  })
}
