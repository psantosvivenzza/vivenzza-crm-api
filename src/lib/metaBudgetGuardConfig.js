// Leitura da config do guard de budget — mesma tabela singleton (automacoes_config,
// id=1) e mesmo padrão de cache curto de src/lib/collection/featureFlags.js, mas
// com seu próprio módulo porque as flags aqui não têm nada a ver com cobrança.
import { supabase } from './supabase-admin.server.js'

const CACHE_TTL_MS = 5000

const DEFAULTS = {
  meta_budget_guard_enabled: false,
  meta_budget_guard_dry_run: true,
  meta_budget_guard_alert_threshold: 115,
  meta_budget_guard_protect_threshold: 125,
  meta_budget_guard_hard_cap: 150,
}

let cache = null
let cacheAt = 0

export function invalidarCacheMetaGuardConfig() {
  cache = null
  cacheAt = 0
}

export async function obterConfigMetaGuard() {
  const agora = Date.now()
  if (cache && agora - cacheAt < CACHE_TTL_MS) return cache

  const { data, error } = await supabase.from('automacoes_config').select('*').eq('id', 1).maybeSingle()
  if (error) throw error

  cache = { ...DEFAULTS, ...(data || {}) }
  cacheAt = agora
  return cache
}
