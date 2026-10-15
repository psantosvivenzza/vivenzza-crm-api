import { createHash, randomUUID } from 'node:crypto'

// Primeiro incremento: nenhum adaptador real, bootstrap, cron ou rota é importado.
// O store deve oferecer CAS atômico e guardar conteúdo/histórico juntos.
export class CampaignApprovalError extends Error {
  constructor(code) { super(code); this.code = code }
}
const fail = (code) => { throw new CampaignApprovalError(code) }
const clone = (value) => structuredClone(value)
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const keys = (value, expected) => {
  if (!plain(value) || Object.keys(value).sort().join('|') !== [...expected].sort().join('|')) fail('CONTRATO_INVALIDO')
}
const str = (value, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('CONTRATO_INVALIDO')
}
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const timestamp = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('DATA_INVALIDA')
  return Date.parse(value)
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export function campaignProposalHash(payload) {
  return createHash('sha256').update(canonical(payload)).digest('hex')
}
function validatePayload(p) {
  keys(p, ['schemaVersion', 'platform', 'accountId', 'campaignId', 'action', 'before', 'after', 'objective', 'reason', 'evidence', 'expiresAt'])
  if (p.schemaVersion !== 1 || !['meta', 'google'].includes(p.platform) || !['status', 'daily_budget'].includes(p.action)) fail('ACAO_NAO_PERMITIDA')
  str(p.accountId, 100); str(p.campaignId, 100); str(p.objective); str(p.reason, 2000)
  for (const snapshot of [p.before, p.after]) {
    keys(snapshot, ['status', 'dailyBudgetMinor', 'currency'])
    if (!['ACTIVE', 'PAUSED'].includes(snapshot.status) || !integer(snapshot.dailyBudgetMinor) || !/^[A-Z]{3}$/.test(snapshot.currency)) fail('ESTADO_INVALIDO')
  }
  if (p.before.currency !== p.after.currency) fail('MOEDA_DIVERGENTE')
  const changedStatus = p.before.status !== p.after.status
  const changedBudget = p.before.dailyBudgetMinor !== p.after.dailyBudgetMinor
  if (p.action === 'status' ? (!changedStatus || changedBudget) : (!changedBudget || changedStatus)) fail('ESCOPO_DIVERGENTE')
  keys(p.evidence, ['observedAt', 'source', 'summary'])
  timestamp(p.evidence.observedAt); timestamp(p.expiresAt)
  str(p.evidence.source, 200); str(p.evidence.summary, 2000)
}
function admin(actor) {
  if (!plain(actor) || actor.role !== 'admin' || typeof actor.id !== 'string' || !actor.id.trim()) fail('ADMIN_OBRIGATORIO')
}
function allowed(p, policy, now) {
  if (!plain(policy) || !Array.isArray(policy.scopes) || policy.scopes.some((s) => !plain(s) || !Array.isArray(s.campaignIds) || !Array.isArray(s.actions))) fail('POLITICA_INVALIDA')
  const scope = policy.scopes.find((s) => s.platform === p.platform && s.accountId === p.accountId && s.campaignIds.includes(p.campaignId))
  if (!scope || !scope.actions.includes(p.action) || scope.currency !== p.after.currency) fail('ALVO_NAO_PERMITIDO')
  if (!integer(scope.maxDailyBudgetMinor) || !integer(scope.maxBudgetDeltaMinor) || !integer(policy.maxEvidenceAgeMs) || policy.maxEvidenceAgeMs === 0 || !integer(policy.maxApprovalAgeMs) || policy.maxApprovalAgeMs === 0) fail('POLITICA_INVALIDA')
  if (p.after.dailyBudgetMinor > scope.maxDailyBudgetMinor || Math.abs(p.after.dailyBudgetMinor - p.before.dailyBudgetMinor) > scope.maxBudgetDeltaMinor) fail('LIMITE_EXCEDIDO')
  const observed = timestamp(p.evidence.observedAt)
  if (observed > now || now - observed > policy.maxEvidenceAgeMs) fail('EVIDENCIA_DESATUALIZADA')
  if (timestamp(p.expiresAt) <= now) fail('PROPOSTA_EXPIRADA')
}
function intact(record) {
  validatePayload(record.payload)
  if (record.hash !== campaignProposalHash(record.payload)) fail('CONTEUDO_ALTERADO')
}
const event = (state, actor, at, code = null) => ({ state, actorId: actor.id, at, code })

/** Trusted ports: actor comes from server authentication, policy is server-owned.
 * store.get/insert/compareAndSwap return detached records; CAS atomically compares
 * revision and stores the entire record including history. No durable store here.
 */
export function createSyntheticCampaignWorkflow({ store, policy, adapter, clock = () => Date.now(), id = randomUUID }) {
  if (!store || typeof store.compareAndSwap !== 'function') fail('STORE_OBRIGATORIO')
  // Deliberately no production transport support in this increment.
  if (adapter && adapter.mode !== 'synthetic') fail('EXECUTOR_REAL_NAO_IMPLEMENTADO')
  const nowMs = () => {
    const now = clock()
    if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000) fail('RELOGIO_INVALIDO')
    return now
  }
  const currentPolicy = () => clone(typeof policy === 'function' ? policy() : policy)
  const load = async (proposalId) => {
    const record = await store.get(proposalId)
    if (!record) fail('PROPOSTA_NAO_ENCONTRADA')
    intact(record)
    return record
  }
  const commit = async (old, next) => {
    next.revision = old.revision + 1
    if (!await store.compareAndSwap(old.id, old.revision, clone(next))) fail('CONFLITO_DE_ESTADO')
    return clone(next)
  }
  const checkApproval = (record, hash, now, rules) => {
    if (hash !== record.hash) fail('CONTEUDO_ALTERADO')
    allowed(record.payload, rules, now)
    if (!record.approval || record.approval.hash !== record.hash || timestamp(record.approval.expiresAt) <= now) fail('APROVACAO_INVALIDA')
  }
  return {
    async propose(payload, actor) {
      admin(actor)
      const copy = clone(payload); validatePayload(copy)
      const now = nowMs(); allowed(copy, currentPolicy(), now)
      const at = new Date(now).toISOString()
      const record = { id: id(), revision: 1, payload: copy, hash: campaignProposalHash(copy), state: 'proposta', approval: null, history: [event('proposta', actor, at)] }
      if (!await store.insert(clone(record))) fail('ID_DUPLICADO')
      return clone(record)
    },
    async approve(proposalId, expectedHash, actor) {
      admin(actor)
      const old = await load(proposalId)
      if (old.state !== 'proposta') fail('ESTADO_NAO_PERMITE_APROVAR')
      if (old.hash !== expectedHash) fail('CONTEUDO_ALTERADO')
      const now = nowMs(); const rules = currentPolicy(); allowed(old.payload, rules, now)
      const at = new Date(now).toISOString()
      return commit(old, { ...old, state: 'aprovada', approval: { hash: old.hash, actorId: actor.id, at, expiresAt: new Date(Math.min(timestamp(old.payload.expiresAt), now + rules.maxApprovalAgeMs)).toISOString() }, history: [...old.history, event('aprovada', actor, at)] })
    },
    async execute(proposalId, expectedHash, actor) {
      admin(actor)
      if (!adapter || typeof adapter.read !== 'function' || typeof adapter.write !== 'function') fail('EXECUTOR_NAO_CONFIGURADO')
      const old = await load(proposalId)
      if (old.state !== 'aprovada') fail('ESTADO_NAO_PERMITE_EXECUTAR')
      const claimedAt = nowMs()
      checkApproval(old, expectedHash, claimedAt, currentPolicy())
      let active = await commit(old, { ...old, state: 'em execução', history: [...old.history, event('em execução', actor, new Date(claimedAt).toISOString())] })
      let writeStarted = false
      let finalState; let code
      const target = { platform: active.payload.platform, accountId: active.payload.accountId, campaignId: active.payload.campaignId }
      try {
        const before = await adapter.read(clone(target))
        keys(before, ['platform', 'accountId', 'campaignId', 'snapshot'])
        if (canonical(before) !== canonical({ ...target, snapshot: active.payload.before })) fail('PRECONDICAO_DIVERGENTE')
        // Recheck time and current server policy after potentially slow reads.
        checkApproval(active, expectedHash, nowMs(), currentPolicy())
        writeStarted = true
        await adapter.write({ ...clone(target), action: active.payload.action, snapshot: clone(active.payload.after), idempotencyKey: `${active.id}:${active.hash}` })
        const after = await adapter.read(clone(target))
        keys(after, ['platform', 'accountId', 'campaignId', 'snapshot'])
        finalState = canonical(after) === canonical({ ...target, snapshot: active.payload.after }) ? 'confirmada' : 'inconclusiva'
        code = finalState === 'confirmada' ? 'READBACK_CONFIRMADO' : 'READBACK_DIVERGENTE'
      } catch (error) {
        finalState = writeStarted ? 'inconclusiva' : 'falhou'
        code = writeStarted ? 'ESCRITA_OU_READBACK_INCERTO' : (error instanceof CampaignApprovalError ? error.code : 'PREPARACAO_OU_LEITURA_FALHOU')
      }
      // A persistence failure leaves em execução; never repeat the provider write.
      active = await commit(active, { ...active, state: finalState, history: [...active.history, event(finalState, actor, new Date(nowMs()).toISOString(), code)] })
      return active
    },
    async get(proposalId, actor) { admin(actor); return clone(await load(proposalId)) },
  }
}
