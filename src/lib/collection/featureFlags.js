// Leitura centralizada de automacoes_config para o motor de cobrança v2. Mesmo
// padrão de kill-switch já usado por cobranca-whatsapp.js (linha única id=1,
// leitura estrita === true) — só que aqui cobre todas as flags novas de uma vez,
// pra não espalhar `.select('coluna_x').eq('id', 1)` repetido por 10 arquivos.
//
// Cache curto (5s) em memória: o motor de dispatch consulta flags/limites várias
// vezes por execução (uma vez por conta candidata) — sem cache isso vira uma
// query extra por conta, sem necessidade (a config não muda no meio de uma
// execução de alguns minutos).
import { supabase } from '../supabase-admin.server.js'

const CACHE_TTL_MS = 5000

const DEFAULTS = {
  collection_engine_v2: false,
  multi_whatsapp: false,
  whatsapp_failover: false,
  ai_whatsapp: false,
  ai_knowledge: false,
  recovery_score: false,
  priority_score: false,
  next_best_action: false,
  ai_voice_calls: false,
  human_call_alerts: false,
  // FASE B.5 (homologação, 2026-08-11) — threshold de priority_score pra
  // nextBestAction.js recomendar HUMAN_CALL. Calibrado com a carteira
  // elegível completa real (1.108 contas, priority máximo real = 69) — o
  // valor antigo (80, hardcoded) nunca era atingido. Default aqui cobre o
  // caso da coluna ainda não existir em automacoes_config (select('*') não
  // retorna a chave e o merge com DEFAULTS preserva 65) — funciona igual
  // com ou sem a migration aditiva aplicada.
  human_call_priority_threshold: 65,
  ml_recovery_score: false,
  min_send_delay_seconds: 45,
  max_send_delay_seconds: 90,
  global_daily_limit: 30,
  global_hourly_limit: 10,
  delivery_timeout_minutes: 30,
  failover_on_delivery_timeout: false,
  ai_shadow_mode: false,
  nba_shadow_mode: false,
  score_shadow_mode: false,
  shadow_max_customers: 50,
  // PASSO 21 (homologação) — piloto gradual, ver src/lib/collection/pilotFilter.js.
  // NULL = sem restrição (não confundir com 0, que exclui 100% da carteira).
  collection_v2_pilot_percent: null,
  collection_v2_pilot_client_ids: null,
}

let cache = null
let cacheAt = 0

// Exportado só para os scripts de teste manuais (scripts/teste-*.mjs) poderem
// forçar releitura entre casos — não é usado pelo código de produção.
export function invalidarCacheFlags() {
  cache = null
  cacheAt = 0
}

export async function obterConfigCobranca() {
  const agora = Date.now()
  if (cache && agora - cacheAt < CACHE_TTL_MS) return cache

  const { data, error } = await supabase.from('automacoes_config').select('*').eq('id', 1).maybeSingle()
  if (error) throw error

  cache = { ...DEFAULTS, ...(data || {}) }
  cacheAt = agora
  return cache
}

export async function flagAtiva(nome) {
  if (!(nome in DEFAULTS)) {
    throw new Error(`Flag desconhecida: ${nome}`)
  }
  const config = await obterConfigCobranca()
  return config[nome] === true
}
