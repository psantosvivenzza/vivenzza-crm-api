// CRM is the sole durable transport owner. Provider metadata is identity
// evidence, never permission to downgrade an already migrated connection.
export class WhatsappOwnershipError extends Error {
  constructor() {
    super('A propriedade da conexão WhatsApp não pôde ser confirmada.')
    this.name = 'WhatsappOwnershipError'
    this.code = 'FZAP_OWNERSHIP'
    this.status = 503
    this.response = { status: 503 }
  }
}

export function createWhatsappOwnershipStore({ client, ttlMs = 2_000, now = () => Date.now() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > 5_000 || typeof now !== 'function') throw new WhatsappOwnershipError()
  const cache = new Map(), inflight = new Map(), versions = new Map()
  const database = async () => client || (await import('./supabase-admin.server.js')).supabase
  const checkedId = (id) => {
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw new WhatsappOwnershipError()
    return id
  }
  async function execute(query) {
    try {
      const result = await query.abortSignal(AbortSignal.timeout(10_000))
      if (result?.error) throw new Error()
      return result?.data
    } catch { throw new WhatsappOwnershipError() }
  }
  function invalidate(id) {
    cache.delete(id)
    inflight.delete(id)
    versions.set(id, (versions.get(id) || 0) + 1)
  }
  async function read(id) {
    try {
      const db = await database()
      const row = await execute(db.from('whatsapp_connections').select('owner,migration_requested,instance_name,finalidade').eq('id', checkedId(id)).maybeSingle())
      if (!row || !['evolution', 'fzap'].includes(row.owner) || typeof row.migration_requested !== 'boolean'
        || typeof row.instance_name !== 'string' || !row.instance_name || !['comercial', 'financeiro', 'notificacoes'].includes(row.finalidade)) throw new Error()
      return Object.freeze({ owner: row.owner, migrationRequested: row.migration_requested, instanceName: row.instance_name, finalidade: row.finalidade })
    } catch { throw new WhatsappOwnershipError() }
  }
  async function get(id) {
    checkedId(id)
    const cached = cache.get(id)
    if (cached && cached.expires > now()) return cached.value
    cache.delete(id)
    if (inflight.has(id)) return inflight.get(id)
    const version = versions.get(id) || 0
    const pending = Promise.resolve().then(() => read(id)).then((value) => {
      // An overlapping write invalidates this read. Re-read instead of
      // returning/caching the previous owner after a migration completes.
      if ((versions.get(id) || 0) !== version) return get(id)
      if (ttlMs > 0) cache.set(id, { value, expires: now() + ttlMs })
      return value
    }).catch(() => {
      cache.delete(id) // errors are never cached and never use stale ownership
      throw new WhatsappOwnershipError()
    }).finally(() => {
      if (inflight.get(id) === pending) inflight.delete(id)
    })
    inflight.set(id, pending)
    return pending
  }
  async function write(id, build) {
    checkedId(id)
    invalidate(id)
    try { await execute(build(await database())) } finally { invalidate(id) }
  }
  async function request(id) {
    try {
      await write(id, (db) => db.from('whatsapp_connections').update({ migration_requested: true, updated_at: new Date(now()).toISOString() }).eq('id', id).eq('owner', 'evolution'))
      const state = await get(id)
      if (state.owner !== 'fzap' && !state.migrationRequested) throw new Error()
      return state
    } catch { throw new WhatsappOwnershipError() }
  }
  async function complete(id) {
    try {
      const timestamp = new Date(now()).toISOString()
      await write(id, (db) => db.from('whatsapp_connections').update({ owner: 'fzap', migration_requested: false, migrated_at: timestamp, updated_at: timestamp }).eq('id', id).eq('owner', 'evolution').eq('migration_requested', true))
      const state = await get(id)
      if (state.owner !== 'fzap') throw new Error()
      return state
    } catch { throw new WhatsappOwnershipError() }
  }
  return { get, request, complete }
}

export const ownershipStore = createWhatsappOwnershipStore()
export default ownershipStore
