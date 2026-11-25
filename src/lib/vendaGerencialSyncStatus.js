// Status de frescor do sync gerencial (NetVision EN_NotasRepres →
// vendas_gerenciais_netvision), mesma convenção de
// src/lib/collection/financialSyncGuard.js e src/lib/vendaFiscalSyncStatus.js
// — aqui é sincronizacoes_vendas_gerenciais, domínio próprio, não
// compartilha guard com o fiscal (fontes diferentes, EN_NotasRepres x
// EN_Notas — ver VENDAS_DO_MES_RECONCILIACAO.md).
//
// Usado pelo indicador "VENDAS DO MÊS" (agora vendas_gerenciais_mes) do
// dashboard pra decidir se pode mostrar o valor agregado ou se precisa
// marcar disponivel=false. Não bloqueia nada (não é um guard de envio) — é
// só a fonte da verdade de "os dados que eu tenho são confiáveis pra
// mostrar agora?".
//
// Fail-closed em todo caminho de falha, mesmo racional dos outros guards de
// frescor: nunca sincronizou, consulta falhou, último ciclo não terminou
// bem, ou terminou mas está mais velho que o limite — todos resultam em
// disponivel=false.
import { supabase } from './supabase-admin.server.js'

const DEFAULT_MAX_ATRASO_MIN = 30 // 10-minute schedule; never present older data as current

function lerMaxAtrasoMin() {
  const env = Number(process.env.VENDAS_GERENCIAIS_SYNC_MAX_ATRASO_MIN)
  return Number.isFinite(env) && env > 0 ? Math.min(env, DEFAULT_MAX_ATRASO_MIN) : DEFAULT_MAX_ATRASO_MIN
}

function resultado({ disponivel, reason, lastSyncAt = null, ageMinutes = null, maxAgeMinutes }) {
  return { disponivel, reason, last_sync_at: lastSyncAt, age_minutes: ageMinutes, max_age_minutes: maxAgeMinutes }
}

/**
 * `clienteSupabase` injetável só pra teste do caminho de erro de consulta
 * (nunca passado em produção).
 */
export async function verificarStatusSyncGerencial({ clienteSupabase = supabase } = {}) {
  const maxAtrasoMin = lerMaxAtrasoMin()

  try {
    const { data, error } = await clienteSupabase
      .from('sincronizacoes_vendas_gerenciais')
      .select('status, iniciado_em, concluido_em, total_com_erro')
      .eq('dry_run', false)
      .order('iniciado_em', { ascending: false })
      .limit(2)
      .abortSignal(AbortSignal.timeout(8000))

    if (error) return resultado({disponivel:false,reason:'erro_consulta_banco',maxAgeMinutes:maxAtrasoMin})
    // A running cycle does not invalidate the preceding completed snapshot.
    // Failed cycles still fail closed; the preceding snapshot must remain fresh.
    const latest = data?.[0]
    const snapshot = latest?.status === 'executando' ? data?.[1] : latest
    return avaliarStatusSyncGerencial(snapshot, { maxAgeMinutes: maxAtrasoMin })
  } catch (err) {
    return resultado({ disponivel: false, reason: 'erro_consulta_banco', maxAgeMinutes: maxAtrasoMin })
  }
}

export function avaliarStatusSyncGerencial(data,{now=Date.now(),maxAgeMinutes=DEFAULT_MAX_ATRASO_MIN}={}) {
    if (!data) return resultado({ disponivel: false, reason: 'nunca_sincronizou', maxAgeMinutes: maxAgeMinutes })
    if (data.status === 'falhou') return resultado({ disponivel: false, reason: 'ultimo_sync_falhou', lastSyncAt: data.concluido_em ?? data.iniciado_em, maxAgeMinutes: maxAgeMinutes })
    if (data.status === 'executando') return resultado({ disponivel: false, reason: 'ultimo_sync_em_andamento', maxAgeMinutes: maxAgeMinutes })
    if (!Number.isFinite(Number(data.total_com_erro ?? 0)) || Number(data.total_com_erro ?? 0) !== 0) {
      return resultado({ disponivel: false, reason: 'ultimo_sync_com_erros', lastSyncAt: data.concluido_em, maxAgeMinutes: maxAgeMinutes })
    }
    if (data.status !== 'concluido') return resultado({disponivel:false,reason:'ultimo_sync_status_invalido',maxAgeMinutes})
    if (!data.concluido_em) return resultado({ disponivel: false, reason: 'ultimo_sync_sem_timestamp_conclusao', maxAgeMinutes: maxAgeMinutes })

    const concluidoEm = new Date(data.concluido_em)
    if (Number.isNaN(concluidoEm.getTime())) {
      return resultado({ disponivel: false, reason: 'timestamp_invalido', lastSyncAt: data.concluido_em, maxAgeMinutes: maxAgeMinutes })
    }

    const elapsed = now - concluidoEm.getTime()
    if (elapsed < 0) return resultado({disponivel:false,reason:'timestamp_futuro',lastSyncAt:data.concluido_em,maxAgeMinutes})
    const ageMinutes = Math.floor(elapsed / 60000)
    if (elapsed > maxAgeMinutes * 60000) {
      return resultado({ disponivel: false, reason: 'sync_desatualizado', lastSyncAt: data.concluido_em, ageMinutes, maxAgeMinutes: maxAgeMinutes })
    }
    return resultado({ disponivel: true, reason: null, lastSyncAt: data.concluido_em, ageMinutes, maxAgeMinutes: maxAgeMinutes })
}


