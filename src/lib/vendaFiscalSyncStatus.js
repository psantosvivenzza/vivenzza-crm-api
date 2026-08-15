// Status de frescor do sync fiscal (NetVision EN_Notas → notas_fiscais_netvision),
// mesma convenção de src/lib/collection/financialSyncGuard.js contra
// sincronizacoes_financeiro — aqui é sincronizacoes_fiscal.
//
// Usado só pelo indicador "VENDAS DO MÊS" do dashboard (src/routes/dashboard.js)
// pra decidir se pode mostrar o valor agregado ou se precisa marcar
// disponivel=false. Não bloqueia nada (não é um guard de envio como o
// financeiro) — é só a fonte da verdade de "os dados que eu tenho são
// confiáveis pra mostrar agora?".
//
// Fail-closed em todo caminho de falha, mesmo racional do guard financeiro:
// nunca sincronizou, consulta falhou, último ciclo não terminou bem, ou
// terminou mas está mais velho que o limite — todos resultam em disponivel=false.
import { supabase } from './supabase-admin.server.js'

const DEFAULT_MAX_ATRASO_MIN = 1440 // 24h — indicador de dashboard, não guard de envio; não precisa da mesma janela apertada do financeiro (240min)

function lerMaxAtrasoMin() {
  const env = Number(process.env.VENDAS_FISCAIS_SYNC_MAX_ATRASO_MIN)
  return Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_ATRASO_MIN
}

function resultado({ disponivel, reason, lastSyncAt = null, ageMinutes = null, maxAgeMinutes }) {
  return { disponivel, reason, last_sync_at: lastSyncAt, age_minutes: ageMinutes, max_age_minutes: maxAgeMinutes }
}

/**
 * `clienteSupabase` injetável só pra teste do caminho de erro de consulta
 * (nunca passado em produção).
 */
export async function verificarStatusSyncFiscal({ clienteSupabase = supabase } = {}) {
  const maxAtrasoMin = lerMaxAtrasoMin()

  try {
    const { data, error } = await clienteSupabase
      .from('sincronizacoes_fiscal')
      .select('status, iniciado_em, concluido_em, total_com_erro')
      .eq('dry_run', false)
      .order('iniciado_em', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) return resultado({ disponivel: false, reason: 'erro_consulta_banco', maxAgeMinutes: maxAtrasoMin })
    if (!data) return resultado({ disponivel: false, reason: 'nunca_sincronizou', maxAgeMinutes: maxAtrasoMin })
    if (data.status === 'falhou') return resultado({ disponivel: false, reason: 'ultimo_sync_falhou', lastSyncAt: data.concluido_em ?? data.iniciado_em, maxAgeMinutes: maxAtrasoMin })
    if (data.status === 'executando') return resultado({ disponivel: false, reason: 'ultimo_sync_em_andamento', maxAgeMinutes: maxAtrasoMin })
    if (Number(data.total_com_erro || 0) > 0) {
      return resultado({ disponivel: false, reason: 'ultimo_sync_com_erros', lastSyncAt: data.concluido_em, maxAgeMinutes: maxAtrasoMin })
    }
    if (!data.concluido_em) return resultado({ disponivel: false, reason: 'ultimo_sync_sem_timestamp_conclusao', maxAgeMinutes: maxAtrasoMin })

    const concluidoEm = new Date(data.concluido_em)
    if (Number.isNaN(concluidoEm.getTime())) {
      return resultado({ disponivel: false, reason: 'timestamp_invalido', lastSyncAt: data.concluido_em, maxAgeMinutes: maxAtrasoMin })
    }

    const ageMinutes = Math.round((Date.now() - concluidoEm.getTime()) / 60000)
    if (ageMinutes > maxAtrasoMin) {
      return resultado({ disponivel: false, reason: 'sync_desatualizado', lastSyncAt: data.concluido_em, ageMinutes, maxAgeMinutes: maxAtrasoMin })
    }
    return resultado({ disponivel: true, reason: null, lastSyncAt: data.concluido_em, ageMinutes, maxAgeMinutes: maxAtrasoMin })
  } catch (err) {
    return resultado({ disponivel: false, reason: 'erro_consulta_banco', maxAgeMinutes: maxAtrasoMin })
  }
}
