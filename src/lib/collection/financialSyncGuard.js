// Guard de frescor do sync financeiro (NetVision → CRM). Decide se a
// "verdade financeira" (contas_financeiras) está atualizada o suficiente
// pra autorizar cobrança — consultando o histórico real da sincronização em
// `sincronizacoes_financeiro` (ver src/jobs/sync-financeiro-legado.js, que
// roda fora do Railway, na máquina do escritório, e escreve nessa tabela a
// cada ciclo).
//
// Achado real (2026-08-14): a régua de cobrança nunca checou isso — se o
// worker de sync caísse silenciosamente, a cobrança continuaria rodando com
// dados cada vez mais velhos, sem trava nenhuma. Este módulo fecha esse
// buraco. É uma proteção DIFERENTE de paymentGuard.js (título quitado?) e
// de em_revisao_financeira (conflito conhecido?) — as três precisam
// concordar antes de qualquer envio: sync fresco + título não em revisão +
// título ainda em aberto + demais regras da régua.
//
// Fail-closed em TODO caminho de falha: nunca sincronizou, consulta ao
// banco falhou, ciclo mais recente não concluiu com sucesso, ou o mais
// recente concluído está mais velho que o limite — todos bloqueiam.
import { supabase } from '../supabase-admin.server.js'

const DEFAULT_MAX_ATRASO_MIN = 240
// 30-60s pedido explicitamente — evita consultar o banco a cada mensagem
// num lote longo, sem deixar a decisão ficar velha demais dentro da própria
// janela de segurança (a régua manda 1 mensagem a cada 45-90s, então o
// cache expira bem antes da próxima consulta de qualquer forma).
const CACHE_TTL_MS = 45_000

function lerConfig() {
  const exigeSyncEnv = process.env.COBRANCA_EXIGE_SYNC
  // Preferência de segurança explícita: ausente = true (nunca "ausente ==
  // desligado" pra um guard de segurança). Só string literal "false"
  // desliga.
  const exigeSync = exigeSyncEnv === undefined || exigeSyncEnv === '' ? true : exigeSyncEnv !== 'false'

  const maxAtrasoEnv = Number(process.env.COBRANCA_SYNC_MAX_ATRASO_MIN)
  const maxAtrasoMin = Number.isFinite(maxAtrasoEnv) && maxAtrasoEnv > 0 ? maxAtrasoEnv : DEFAULT_MAX_ATRASO_MIN

  return { exigeSync, maxAtrasoMin }
}

let cache = null // { resultado, expiraEm }

function resultado({ allowed, reason, lastSyncAt = null, ageMinutes = null, maxAgeMinutes }) {
  return { allowed, reason, last_sync_at: lastSyncAt, age_minutes: ageMinutes, max_age_minutes: maxAgeMinutes }
}

/**
 * Decide se a cobrança pode prosseguir agora. Cacheado por CACHE_TTL_MS —
 * passe `ignorarCache: true` pra forçar uma consulta nova (testes/status).
 * `clienteSupabase` é injetável só pra teste unitário do caminho de erro de
 * consulta (nunca passado em produção — default é o client real).
 */
export async function verificarFrescorSync({ ignorarCache = false, clienteSupabase = supabase } = {}) {
  const { exigeSync, maxAtrasoMin } = lerConfig()

  if (!exigeSync) {
    return resultado({ allowed: true, reason: 'guard_desabilitado', maxAgeMinutes: maxAtrasoMin })
  }

  if (!ignorarCache && cache && cache.expiraEm > Date.now()) {
    return cache.resultado
  }

  let r
  try {
    // O ciclo mais recente decide — não procura um ciclo antigo bem-sucedido
    // pra "passar por baixo" de uma falha atual. dry_run nunca conta (não
    // representa um espelhamento real dos dados).
    const { data, error } = await clienteSupabase
      .from('sincronizacoes_financeiro')
      .select('status, iniciado_em, concluido_em, total_com_erro')
      .eq('dry_run', false)
      .order('iniciado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      r = resultado({ allowed: false, reason: 'erro_consulta_banco', maxAgeMinutes: maxAtrasoMin })
    } else if (!data) {
      r = resultado({ allowed: false, reason: 'nunca_sincronizou', maxAgeMinutes: maxAtrasoMin })
    } else if (data.status === 'falhou') {
      r = resultado({ allowed: false, reason: 'ultimo_sync_falhou', lastSyncAt: data.concluido_em ?? data.iniciado_em, maxAgeMinutes: maxAtrasoMin })
    } else if (data.status === 'executando') {
      r = resultado({ allowed: false, reason: 'ultimo_sync_em_andamento', maxAgeMinutes: maxAtrasoMin })
    } else if (Number(data.total_com_erro || 0) > 0) {
      // Cobre status='concluido_com_erros' e qualquer 'concluido' com erro
      // parcial — pelo menos um título não foi verificado corretamente
      // nesse ciclo, não é confiável o suficiente pra liberar cobrança.
      r = resultado({ allowed: false, reason: 'ultimo_sync_com_erros', lastSyncAt: data.concluido_em, maxAgeMinutes: maxAtrasoMin })
    } else if (!data.concluido_em) {
      r = resultado({ allowed: false, reason: 'ultimo_sync_sem_timestamp_conclusao', maxAgeMinutes: maxAtrasoMin })
    } else {
      const concluidoEm = new Date(data.concluido_em)
      if (Number.isNaN(concluidoEm.getTime())) {
        r = resultado({ allowed: false, reason: 'timestamp_invalido', lastSyncAt: data.concluido_em, maxAgeMinutes: maxAtrasoMin })
      } else {
        const ageMinutes = Math.round((Date.now() - concluidoEm.getTime()) / 60000)
        r = ageMinutes > maxAtrasoMin
          ? resultado({ allowed: false, reason: 'sync_stale', lastSyncAt: data.concluido_em, ageMinutes, maxAgeMinutes: maxAtrasoMin })
          : resultado({ allowed: true, reason: null, lastSyncAt: data.concluido_em, ageMinutes, maxAgeMinutes: maxAtrasoMin })
      }
    }
  } catch (err) {
    r = resultado({ allowed: false, reason: 'erro_consulta_banco', maxAgeMinutes: maxAtrasoMin })
  }

  cache = { resultado: r, expiraEm: Date.now() + CACHE_TTL_MS }
  return r
}

export function logBloqueioSyncStale(origem, guard) {
  console.error(
    `[financial-sync-guard] COLLECTION_BLOCKED_FINANCIAL_SYNC_STALE origem=${origem} ` +
    `reason=${guard.reason} last_sync_at=${guard.last_sync_at} age_minutes=${guard.age_minutes} max_age_minutes=${guard.max_age_minutes}`
  )
}

// Só para testes — evita que o cache de um teste vaze pro próximo.
export function _resetCacheParaTeste() {
  cache = null
}
