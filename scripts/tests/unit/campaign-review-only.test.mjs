// Modo somente revisão: decisão persistível sem capacidade de execução. Store em memória, sem rede.
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { campaignProposalHash, createCampaignReviewWorkflow, createSyntheticCampaignWorkflow } from '../../../src/lib/campaignApproval.js'
import { MANUAL_SOURCE, createCampaignReviewComposition, createManualProposalIntake } from '../../../src/lib/campaignReviewComposition.js'

net.Socket.prototype.connect = () => { throw new Error('NETWORK_FORBIDDEN') }
globalThis.fetch = () => { throw new Error('FETCH_FORBIDDEN') }
const admin = { id: 'admin-sintetico', role: 'admin' }
const base = Date.parse('2026-10-15T19:00:00.000Z')
const rules = { maxEvidenceAgeMs: 300_000, maxApprovalAgeMs: 120_000, scopes: [{ platform: 'meta', accountId: 'conta-homologacao', campaignIds: ['campanha-homologacao'], actions: ['daily_budget', 'status'], currency: 'BRL', maxDailyBudgetMinor: 5000, maxBudgetDeltaMinor: 1000 }] }
const input = (extra = {}) => ({ platform: 'meta', accountId: 'conta-homologacao', campaignId: 'campanha-homologacao', action: 'daily_budget',
  before: { status: 'ACTIVE', dailyBudgetMinor: 2000, currency: 'BRL' }, after: { status: 'ACTIVE', dailyBudgetMinor: 2500, currency: 'BRL' },
  objective: 'Conversas iniciadas', reason: 'Revisor propõe aumento limitado.', observationSummary: 'Revisor declarou o orçamento visto no gerenciador.', ...extra })
function memory() {
  const rows = new Map(); const calls = []
  return { rows, calls, store: {
    async get(id) { calls.push('get'); return rows.has(id) ? structuredClone(rows.get(id)) : null },
    async list() { calls.push('list'); return [...rows.values()].map((r) => structuredClone(r)) },
    async insert(r) { calls.push('insert'); if (rows.has(r.id)) return false; rows.set(r.id, structuredClone(r)); return true },
    async compareAndSwap(id, revision, r) { calls.push('cas'); if (rows.get(id)?.revision !== revision) return false; rows.set(id, structuredClone(r)); return true },
  } }
}
let seq = 0
const setup = (clock = () => base) => {
  const m = memory()
  const workflow = createCampaignReviewWorkflow({ store: m.store, policy: rules, clock, id: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` })
  return { ...m, workflow, intake: createManualProposalIntake({ workflow, policy: rules, clock }) }
}
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code)

test('workflow de revisão não tem execução e recusa adapter, mesmo sintético', () => {
  const { workflow } = setup()
  assert.equal(typeof workflow.execute, 'undefined')
  assert.deepEqual(workflow.capabilities, { decide: true, execute: false })
  assert.ok(Object.isFrozen(workflow))
  assert.throws(() => createCampaignReviewWorkflow({ store: memory().store, policy: rules, adapter: { mode: 'synthetic', read() {}, write() {} } }), (e) => e.code === 'EXECUTOR_NAO_PERMITIDO_EM_REVISAO')
  assert.throws(() => createCampaignReviewWorkflow({ store: memory().store, policy: rules, adapter: undefined }), (e) => e.code === 'EXECUTOR_NAO_PERMITIDO_EM_REVISAO')
  assert.throws(() => createCampaignReviewComposition({ db: { query() {} }, policy: rules, adapter: {} }), (e) => e.code === 'EXECUTOR_NAO_PERMITIDO_EM_REVISAO')
  assert.throws(() => createCampaignReviewComposition({ policy: rules }), (e) => e.code === 'BANCO_OBRIGATORIO')
  assert.equal(createSyntheticCampaignWorkflow({ store: memory().store, policy: rules }).capabilities.execute, false)
})

test('intake manual: origem, fonte, observação e validade vêm do servidor e entram no hash', async () => {
  const { intake } = setup()
  const r = await intake(input(), admin)
  assert.equal(r.payload.schemaVersion, 2)
  assert.deepEqual(r.payload.origin, { kind: 'manual', verified: false })
  assert.equal(r.payload.evidence.source, MANUAL_SOURCE)
  assert.equal(r.payload.evidence.observedAt, new Date(base).toISOString())
  assert.equal(r.payload.expiresAt, new Date(base + rules.maxEvidenceAgeMs).toISOString())
  assert.equal(r.hash, campaignProposalHash(r.payload))
  assert.notEqual(r.hash, campaignProposalHash({ ...r.payload, origin: { kind: 'synthetic', verified: false } }))
  assert.equal(r.history[0].actorId, 'admin-sintetico')
})

test('intake recusa campos que o navegador não pode declarar', async () => {
  const { intake, rows } = setup()
  for (const extra of [{ origin: { kind: 'manual', verified: true } }, { source: 'Meta API' }, { evidence: {} }, { expiresAt: new Date(base + 1e9).toISOString() }, { observedAt: new Date(base).toISOString() }, { actorId: 'outro' }])
    await rejects(intake(input(extra), admin), 'CONTRATO_INVALIDO')
  await rejects(intake(input({ observationSummary: '  ' }), admin), 'CONTRATO_INVALIDO')
  await rejects(intake(input(), { id: 'v', role: 'vendedor' }), 'ADMIN_OBRIGATORIO')
  await rejects(intake(input({ campaignId: 'fora-da-politica' }), admin), 'ALVO_NAO_PERMITIDO')
  await rejects(intake(input({ after: { status: 'ACTIVE', dailyBudgetMinor: 9000, currency: 'BRL' } }), admin), 'LIMITE_EXCEDIDO')
  assert.equal(rows.size, 0)
})

test('origem verificada ou desconhecida é recusada no contrato v2; v1 continua aceito', async () => {
  const { workflow } = setup()
  const v2 = (origin) => ({ schemaVersion: 2, origin, platform: 'meta', accountId: 'conta-homologacao', campaignId: 'campanha-homologacao', action: 'daily_budget',
    before: { status: 'ACTIVE', dailyBudgetMinor: 2000, currency: 'BRL' }, after: { status: 'ACTIVE', dailyBudgetMinor: 2100, currency: 'BRL' },
    objective: 'o', reason: 'r', evidence: { observedAt: new Date(base).toISOString(), source: 's', summary: 'x' }, expiresAt: new Date(base + 60000).toISOString() })
  await rejects(workflow.propose(v2({ kind: 'manual', verified: true }), admin), 'ORIGEM_VERIFICADA_NAO_SUPORTADA')
  await rejects(workflow.propose(v2({ kind: 'provider_snapshot', verified: false }), admin), 'ORIGEM_INVALIDA')
  await rejects(workflow.propose(v2({ kind: 'manual' }), admin), 'CONTRATO_INVALIDO')
  const { origin, ...v1 } = v2({ kind: 'manual', verified: false })
  await rejects(workflow.propose({ ...v1, schemaVersion: 2 }, admin), 'CONTRATO_INVALIDO')
  assert.equal((await workflow.propose({ ...v1, schemaVersion: 1 }, admin)).payload.schemaVersion, 1)
  await rejects(workflow.propose({ ...v1, schemaVersion: 1, origin }, admin), 'CONTRATO_INVALIDO')
})

test('aprovar registra decisão sem efeito externo; hash, rejeição, validade e CAS preservados', async () => {
  let now = base
  const f = setup(() => now)
  const p = await f.intake(input(), admin)
  await rejects(f.workflow.approve(p.id, 'b'.repeat(64), admin), 'CONTEUDO_ALTERADO')
  const a = await f.workflow.approve(p.id, p.hash, admin)
  assert.equal(a.state, 'aprovada'); assert.equal(a.approval.hash, p.hash); assert.equal(a.revision, 2)
  assert.equal((await f.workflow.get(p.id, admin)).state, 'aprovada')
  await rejects(f.workflow.approve(p.id, p.hash, admin), 'ESTADO_NAO_PERMITE_APROVAR')
  const r = await f.workflow.reject(p.id, p.hash, 'Mudou o plano', admin)
  assert.equal(r.state, 'rejeitada'); assert.deepEqual(r.history.map((e) => e.state), ['proposta', 'aprovada', 'rejeitada'])
  const q = await f.intake(input(), admin)
  now = base + rules.maxEvidenceAgeMs + 1
  await rejects(f.workflow.approve(q.id, q.hash, admin), 'EVIDENCIA_DESATUALIZADA')
  now = base
  // CAS: duas aprovações concorrentes da mesma revisão — só uma grava.
  const c = await f.intake(input(), admin)
  const results = await Promise.allSettled([f.workflow.approve(c.id, c.hash, admin), f.workflow.approve(c.id, c.hash, admin)])
  assert.deepEqual(results.map((x) => x.status).sort(), ['fulfilled', 'rejected'])
  assert.equal(results.find((x) => x.status === 'rejected').reason.code, 'CONFLITO_DE_ESTADO')
})
