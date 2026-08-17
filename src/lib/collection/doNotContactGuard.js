// 2026-08-15 — guard central de DNC/opt-out (collection_do_not_contact) para
// o caminho REAL de cobrança. Achado real: a tabela só era lida pelo shadow
// (nextBestAction.js/estaEmOptOut, usada só por decidirProximaAcao/NBA) — o
// envio de verdade (cron, /disparar, /disparar-individual, motor legado E
// motor v2) nunca verificava opt-out. Com 0 linhas em produção hoje o risco
// era zero na prática, mas era um gap latente real.
//
// Schema de collection_do_not_contact (produção): id, cliente_telefone
// (chave — não é conta/cliente, é telefone), motivo, canal (default 'todos'),
// solicitado_em, registrado_por. Sem ativo/expires_at — presença de linha =
// opt-out permanente até remoção manual. Mesma semântica já usada pelo
// shadow (não inventa campo novo).
import { supabase } from '../supabase-admin.server.js'
import { registrarEvento, ORIGEM } from './timeline.js'
import { hojeBrtISO } from './collectionContactPolicy.js'

// Leitura compartilhada — MESMA query usada pelo guard real (fail-closed,
// abaixo) e por nextBestAction.js/estaEmOptOut() (shadow, fail-open,
// comportamento preservado 100%) — single source of truth sobre "o que conta
// como opt-out", pra shadow e caminho real nunca divergirem sobre isso.
//
// `canais` (2026-08-16) — parametrizado pra reuso pelo guard de voz
// (collection_do_not_contact.canal já suporta 'ligacao', ver migration
// collection_v2_calls_operators — só nunca tinha sido consultado). Default
// preserva EXATAMENTE o comportamento anterior pra todo chamador existente
// (WhatsApp) — nenhum comportamento muda pra quem não passar o parâmetro.
export async function buscarRegistroDoNotContact(clienteTelefone, canais = ['todos', 'whatsapp']) {
  if (!clienteTelefone) return { data: [], error: null }
  return supabase
    .from('collection_do_not_contact')
    .select('id')
    .eq('cliente_telefone', clienteTelefone)
    .in('canal', canais)
    .limit(1)
}

// Guard fail-closed: diferente do shadow (informativo, nunca guarda envio
// real), aqui um erro de consulta ao banco BLOQUEIA o envio — nunca deixa
// passar por causa de uma falha técnica do próprio guard.
export async function estaEmDoNotContact(clienteTelefone, canais = ['todos', 'whatsapp']) {
  if (!clienteTelefone) return { blocked: false, reason: null }

  const { data, error } = await buscarRegistroDoNotContact(clienteTelefone, canais)
  if (error) {
    return { blocked: true, reason: 'DNC_GUARD_ERROR', erro: error.message }
  }
  if ((data?.length ?? 0) > 0) {
    return { blocked: true, reason: 'OPT_OUT' }
  }
  return { blocked: false, reason: null }
}

// Timeline de auditoria do bloqueio — no máximo 1 evento por (título, dia),
// nunca 1 por ciclo/tentativa (um título em DNC pode ser reavaliado várias
// vezes no mesmo dia pelo cron dentro da janela 08h-17h, já que nunca chega a
// 'sent' e portanto nunca é marcado como "já enviado hoje" — sem esta
// deduplicação, cada ciclo geraria um novo evento de timeline pro mesmo
// título, o mesmo dia).
export async function registrarBloqueioOptOutSeNecessario({ contasFinanceirasId, clienteTelefone, reason }) {
  const inicioHojeBrt = `${hojeBrtISO()}T00:00:00-03:00`
  const { data: jaRegistrado, error: erroConsulta } = await supabase
    .from('collection_timeline_events')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .eq('tipo', 'COBRANCA_BLOQUEADA_OPT_OUT')
    .gte('criado_em', inicioHojeBrt)
    .limit(1)
  if (erroConsulta || (jaRegistrado?.length ?? 0) > 0) return // já registrado hoje, ou consulta falhou — nunca falha o bloqueio em si por causa da auditoria

  // Auditoria é best-effort: uma falha ao escrever a timeline nunca pode
  // derrubar o guard em si (o bloqueio do envio já aconteceu antes de chamar
  // esta função — ver enviarCobrancaComRoteamento).
  try {
    await registrarEvento({
      contasFinanceirasId, clienteTelefone, tipo: 'COBRANCA_BLOQUEADA_OPT_OUT', origem: ORIGEM.SYSTEM,
      canal: 'whatsapp', descricao: `Envio de cobrança bloqueado — cliente em opt-out/DNC (${reason})`,
      dados: { reason },
    })
  } catch {
    // silencioso de propósito — ver comentário acima
  }
}
