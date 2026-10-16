import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { campaignProposalHash, createSyntheticCampaignWorkflow } from '../../../src/lib/campaignApproval.js'

// Entire suite is synthetic. Any accidental outbound integration fails immediately.
net.Socket.prototype.connect = () => { throw new Error('NETWORK_FORBIDDEN') }
globalThis.fetch = () => { throw new Error('FETCH_FORBIDDEN') }
const admin = { id: 'admin-sintetico', role: 'admin' }
const base = Date.parse('2026-10-15T19:00:00Z')
const copy = (v) => structuredClone(v)
const payload = (platform = 'meta') => ({ schemaVersion: 1, platform, accountId: 'conta-sintetica', campaignId: 'campanha-sintetica', action: 'daily_budget', before: { status: 'ACTIVE', dailyBudgetMinor: 1000, currency: 'BRL' }, after: { status: 'ACTIVE', dailyBudgetMinor: 1200, currency: 'BRL' }, objective: 'Avaliar alcance com orçamento limitado', reason: 'Simulação contratual; não representa recomendação real.', evidence: { observedAt: new Date(base).toISOString(), source: 'fixture-sintetica', summary: 'Métricas sintéticas separadas por plataforma.' }, expiresAt: new Date(base + 600_000).toISOString() })
function fixture(platform = 'meta') {
  const rows = new Map(); let now = base; let writes = 0; let reads = 0
  let snapshot = copy(payload(platform).before)
  const rules = { maxEvidenceAgeMs: 300_000, maxApprovalAgeMs: 120_000, scopes: [{ platform, accountId: 'conta-sintetica', campaignIds: ['campanha-sintetica'], actions: ['daily_budget', 'status'], currency: 'BRL', maxDailyBudgetMinor: 2000, maxBudgetDeltaMinor: 500 }] }
  const store = {
    async get(id) { return rows.has(id) ? copy(rows.get(id)) : null },
    async insert(r) { if (rows.has(r.id)) return false; rows.set(r.id, copy(r)); return true },
    async compareAndSwap(id, revision, r) { if (rows.get(id)?.revision !== revision) return false; rows.set(id, copy(r)); return true },
  }
  const adapter = { mode: 'synthetic', async read(target) { reads++; return { ...target, snapshot: copy(snapshot) } }, async write(p) { writes++; snapshot = copy(p.snapshot) } }
  const workflow = createSyntheticCampaignWorkflow({ store, policy: () => rules, adapter, clock: () => now, id: () => 'proposta-sintetica' })
  return { rows, store, adapter, rules, workflow, setNow: (n) => { now = n }, setSnapshot: (s) => { snapshot = s }, writes: () => writes, reads: () => reads }
}
async function approved(f, p = payload()) { const r = await f.workflow.propose(p, admin); return f.workflow.approve(r.id, r.hash, admin) }
const rejects = (promise, code) => assert.rejects(promise, (e) => e.code === code)

for (const platform of ['meta', 'google']) test(`${platform}: aprovação e readback confirmam somente resultado operacional`, async () => {
  const f = fixture(platform); const a = await approved(f, payload(platform))
  assert.equal(f.writes(), 0)
  const r = await f.workflow.execute(a.id, a.hash, admin)
  assert.equal(r.state, 'confirmada'); assert.equal(f.writes(), 1); assert.equal(f.reads(), 2)
  assert.deepEqual(r.history.map((e) => e.state), ['proposta', 'aprovada', 'em execução', 'confirmada'])
  assert.equal(r.approval.hash, r.hash)
})
test('hash é independente da ordem das chaves e muda com conteúdo', () => {
  const p = payload(); assert.equal(campaignProposalHash(p), campaignProposalHash(Object.fromEntries(Object.entries(p).reverse())))
  assert.notEqual(campaignProposalHash(p), campaignProposalHash({ ...p, reason: 'Novo motivo' }))
})
test('proposta copia entrada e saída; não permite mutação por referência', async () => {
  const f = fixture(); const p = payload(); const r = await f.workflow.propose(p, admin)
  p.after.dailyBudgetMinor = 9999; r.payload.after.dailyBudgetMinor = 8888
  assert.equal((await f.workflow.get(r.id, admin)).payload.after.dailyBudgetMinor, 1200)
})
test('não administrador não propõe, aprova, executa ou lê', async () => {
  const f = fixture(); const r = await f.workflow.propose(payload(), admin); const user = { id: 'user', role: 'user' }
  await rejects(f.workflow.propose(payload(), user), 'ADMIN_OBRIGATORIO')
  await rejects(f.workflow.approve(r.id, r.hash, user), 'ADMIN_OBRIGATORIO')
  await rejects(f.workflow.execute(r.id, r.hash, user), 'ADMIN_OBRIGATORIO')
  await rejects(f.workflow.get(r.id, user), 'ADMIN_OBRIGATORIO')
})
test('execução exige aprovação explícita do mesmo hash', async () => {
  const f = fixture(); const p = await f.workflow.propose(payload(), admin)
  await rejects(f.workflow.execute(p.id, p.hash, admin), 'ESTADO_NAO_PERMITE_EXECUTAR')
  await rejects(f.workflow.approve(p.id, 'outro-hash', admin), 'CONTEUDO_ALTERADO')
  assert.equal(f.writes(), 0)
})
test('conteúdo adulterado depois de aprovado bloqueia execução', async () => {
  const f = fixture(); const a = await approved(f)
  f.rows.get(a.id).payload.after.dailyBudgetMinor = 1300
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'CONTEUDO_ALTERADO'); assert.equal(f.writes(), 0)
})
test('recalcular hash não transfere aprovação anterior', async () => {
  const f = fixture(); const a = await approved(f); const r = f.rows.get(a.id)
  r.payload.reason = 'Mudou'; r.hash = campaignProposalHash(r.payload)
  await rejects(f.workflow.execute(a.id, r.hash, admin), 'APROVACAO_INVALIDA'); assert.equal(f.writes(), 0)
})
test('whitelist, limite, moeda e alteração de campo fora do escopo', async () => {
  for (const [edit, code] of [
    [(p) => { p.accountId = 'outra' }, 'ALVO_NAO_PERMITIDO'],
    [(p) => { p.campaignId = 'outra' }, 'ALVO_NAO_PERMITIDO'],
    [(p) => { p.after.dailyBudgetMinor = 2100 }, 'LIMITE_EXCEDIDO'],
    [(p) => { p.after.dailyBudgetMinor = 1600 }, 'LIMITE_EXCEDIDO'],
    [(p) => { p.after.currency = 'USD' }, 'MOEDA_DIVERGENTE'],
    [(p) => { p.after.status = 'PAUSED' }, 'ESCOPO_DIVERGENTE'],
    [(p) => { p.url = 'https://example.invalid' }, 'CONTRATO_INVALIDO'],
    [(p) => { p.after.dailyBudgetMinor = 12.5 }, 'ESTADO_INVALIDO'],
  ]) { const f = fixture(); const p = payload(); edit(p); await rejects(f.workflow.propose(p, admin), code); assert.equal(f.writes(), 0) }
})
test('dados antigos, futuros e proposta expirada são recusados', async () => {
  for (const [edit, code] of [
    [(p) => { p.evidence.observedAt = new Date(base - 300001).toISOString() }, 'EVIDENCIA_DESATUALIZADA'],
    [(p) => { p.evidence.observedAt = new Date(base + 1).toISOString() }, 'EVIDENCIA_DESATUALIZADA'],
    [(p) => { p.expiresAt = new Date(base).toISOString() }, 'PROPOSTA_EXPIRADA'],
    [(p) => { p.evidence.observedAt = '2026-10-15 19:00:00' }, 'DATA_INVALIDA'],
  ]) { const f = fixture(); const p = payload(); edit(p); await rejects(f.workflow.propose(p, admin), code) }
})
test('aprovação expira e política atual é verificada novamente', async () => {
  const f = fixture(); const a = await approved(f); f.setNow(base + 120000)
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'APROVACAO_INVALIDA')
  f.setNow(base); f.rules.scopes = []
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'ALVO_NAO_PERMITIDO'); assert.equal(f.writes(), 0)
})
test('concorrência e replay geram no máximo uma escrita', async () => {
  const f = fixture(); const a = await approved(f)
  const results = await Promise.allSettled([f.workflow.execute(a.id, a.hash, admin), f.workflow.execute(a.id, a.hash, admin)])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1); assert.equal(f.writes(), 1)
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'ESTADO_NAO_PERMITE_EXECUTAR'); assert.equal(f.writes(), 1)
})
test('pré-condição divergente falha antes da escrita', async () => {
  const f = fixture(); const a = await approved(f); f.setSnapshot({ ...payload().before, status: 'PAUSED' })
  const r = await f.workflow.execute(a.id, a.hash, admin)
  assert.equal(r.state, 'falhou'); assert.equal(r.history.at(-1).code, 'PRECONDICAO_DIVERGENTE'); assert.equal(f.writes(), 0)
})
test('leitura lenta não ultrapassa validade da aprovação', async () => {
  const f = fixture(); const a = await approved(f); const read = f.adapter.read
  f.adapter.read = async (target) => { const r = await read(target); f.setNow(base + 120001); return r }
  const r = await f.workflow.execute(a.id, a.hash, admin); assert.equal(r.state, 'falhou'); assert.equal(f.writes(), 0)
})
test('timeout de escrita é inconclusivo e não permite retry automático', async () => {
  const f = fixture(); const a = await approved(f); f.adapter.write = async () => { throw new Error('detalhe-provedor-nao-vaza') }
  const r = await f.workflow.execute(a.id, a.hash, admin)
  assert.equal(r.state, 'inconclusiva'); assert.equal(JSON.stringify(r).includes('detalhe-provedor'), false)
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'ESTADO_NAO_PERMITE_EXECUTAR')
})
test('ACK sem readback correspondente não confirma', async () => {
  const f = fixture(); const a = await approved(f); f.adapter.write = async () => ({ success: true })
  const r = await f.workflow.execute(a.id, a.hash, admin)
  assert.equal(r.state, 'inconclusiva'); assert.equal(r.history.at(-1).code, 'READBACK_DIVERGENTE')
})
test('falha na persistência após escrita conserva claim e impede repetição', async () => {
  const f = fixture(); const a = await approved(f); const cas = f.store.compareAndSwap
  f.store.compareAndSwap = async (id, rev, r) => r.state === 'confirmada' ? false : cas(id, rev, r)
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'CONFLITO_DE_ESTADO')
  assert.equal((await f.workflow.get(a.id, admin)).state, 'em execução'); assert.equal(f.writes(), 1)
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'ESTADO_NAO_PERMITE_EXECUTAR')
})
test('não há executor padrão e transporte real é recusado', async () => {
  const f = fixture()
  assert.throws(() => createSyntheticCampaignWorkflow({ store: f.store, policy: f.rules, adapter: { mode: 'live' } }), (e) => e.code === 'EXECUTOR_REAL_NAO_IMPLEMENTADO')
  const w = createSyntheticCampaignWorkflow({ store: f.store, policy: f.rules, clock: () => base })
  const p = await w.propose(payload(), admin); const a = await w.approve(p.id, p.hash, admin)
  await rejects(w.execute(a.id, a.hash, admin), 'EXECUTOR_NAO_CONFIGURADO')
})
test('pausa altera somente status e conserva orçamento', async () => {
  const f = fixture(); const p = payload(); p.action = 'status'; p.after = { ...p.before, status: 'PAUSED' }
  const a = await approved(f, p); const r = await f.workflow.execute(a.id, a.hash, admin)
  assert.equal(r.state, 'confirmada'); assert.equal(r.payload.after.dailyBudgetMinor, p.before.dailyBudgetMinor)
})
test('aprovações simultâneas não substituem autor já registrado', async () => {
  const f = fixture(); const p = await f.workflow.propose(payload(), admin)
  const results = await Promise.allSettled([f.workflow.approve(p.id, p.hash, admin), f.workflow.approve(p.id, p.hash, { id: 'outro-admin', role: 'admin' })])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal((await f.workflow.get(p.id, admin)).history.filter((e) => e.state === 'aprovada').length, 1)
})
test('falha de leitura antes de escrever é falhou; depois de escrever é inconclusiva', async () => {
  for (const failAt of [1, 2]) {
    const f = fixture(); const a = await approved(f); const read = f.adapter.read; let count = 0
    f.adapter.read = async (target) => { if (++count === failAt) throw new Error('provider-failure'); return read(target) }
    const r = await f.workflow.execute(a.id, a.hash, admin)
    assert.equal(r.state, failAt === 1 ? 'falhou' : 'inconclusiva'); assert.equal(f.writes(), failAt === 1 ? 0 : 1)
  }
})
test('readback de outra campanha não confirma mesmo com valores iguais', async () => {
  const f = fixture(); const a = await approved(f); const read = f.adapter.read; let count = 0
  f.adapter.read = async (target) => { const r = await read(target); return ++count === 2 ? { ...r, campaignId: 'outra-campanha' } : r }
  const r = await f.workflow.execute(a.id, a.hash, admin); assert.equal(r.state, 'inconclusiva')
})
test('política removida durante leitura bloqueia escrita', async () => {
  const f = fixture(); const a = await approved(f); const read = f.adapter.read
  f.adapter.read = async (target) => { const r = await read(target); f.rules.scopes = []; return r }
  const r = await f.workflow.execute(a.id, a.hash, admin)
  assert.equal(r.state, 'falhou'); assert.equal(f.writes(), 0)
})
test('relógio inválido antes ou durante leitura nunca permite escrever', async () => {
  for (const invalid of [NaN, Infinity, -1, 1.5]) {
    const f = fixture(); const a = await approved(f); f.setNow(invalid)
    await rejects(f.workflow.execute(a.id, a.hash, admin), 'RELOGIO_INVALIDO'); assert.equal(f.writes(), 0)
  }
  const f = fixture(); const a = await approved(f); const read = f.adapter.read
  f.adapter.read = async (target) => { const r = await read(target); f.setNow(NaN); return r }
  await rejects(f.workflow.execute(a.id, a.hash, admin), 'RELOGIO_INVALIDO')
  assert.equal(f.writes(), 0); assert.equal((await f.workflow.get(a.id, admin)).state, 'em execução')
})
test('strings em allowlists não concedem permissões por substring', async () => {
  for (const field of ['campaignIds', 'actions']) {
    const f = fixture(); f.rules.scopes[0][field] = field === 'campaignIds' ? 'campanha-sintetica-extra' : 'daily_budget-extra'
    await rejects(f.workflow.propose(payload(), admin), 'POLITICA_INVALIDA')
  }
})
test('datas normalizadas silenciosamente pelo parser são rejeitadas', async () => {
  const f = fixture(); const p = payload(); p.evidence.observedAt = '2026-02-30T19:00:00.000Z'
  await rejects(f.workflow.propose(p, admin), 'DATA_INVALIDA')
})
