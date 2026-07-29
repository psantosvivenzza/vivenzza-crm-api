/**
 * Fase 3 do atendimento avançado no WhatsApp: monitora leads ativos cuja última
 * mensagem foi do CLIENTE (direcao='entrada') e escalona notificações in-app
 * conforme o tempo sem resposta: 15min (vendedor), 30min (vendedor+admins),
 * 2h (admins, crítico). Reaproveita a RPC get_ultima_mensagem_por_lead (Fase 1).
 *
 * escalation_log garante 1 notificação por nível por "episódio" de espera — quando
 * o lead volta a ser respondido (última mensagem passa a ser 'saida'), suas linhas
 * são apagadas, liberando os níveis pra dispararem de novo na próxima espera.
 */
import { supabase } from '../lib/supabase.js'

const LIMIAR_15MIN = 15
const LIMIAR_30MIN = 30
const LIMIAR_2H = 120

const TITULOS_POR_NIVEL = {
  1: 'Cliente aguardando resposta',
  2: 'Cliente aguardando há 30 min',
  3: 'Alerta crítico — 2h sem resposta',
}

async function buscarUltimaMensagemEntradaId(leadId) {
  const { data } = await supabase
    .from('whatsapp_mensagens')
    .select('id')
    .eq('lead_id', leadId)
    .eq('direcao', 'entrada')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.id ?? null
}

export async function runMonitoramentoResposta() {
  const agora = Date.now()

  // Só leads ativos — 'fechado'/'perdido' são os estados terminais do funil (leads.js).
  // Paginado: PostgREST limita a 1000 linhas por padrão — sem isso, com milhares de
  // leads ativos, só os primeiros 1000 eram verificados e o resto nunca escalonava.
  const leadsAtivos = []
  const PAGE_LEADS = 1000
  for (let offset = 0; ; offset += PAGE_LEADS) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, nome, responsavel_id')
      .not('etapa', 'in', '(fechado,perdido)')
      .range(offset, offset + PAGE_LEADS - 1)
    if (error) {
      console.error('[monitoramento-resposta] erro ao buscar leads:', error.message)
      return { verificados: 0, notificados: 0 }
    }
    leadsAtivos.push(...data)
    if (data.length < PAGE_LEADS) break
  }
  if (leadsAtivos.length === 0) return { verificados: 0, notificados: 0 }

  const leadsPorId = new Map(leadsAtivos.map((l) => [l.id, l]))
  const leadIds = leadsAtivos.map((l) => l.id)

  // Última mensagem por lead — mesma RPC usada em GET /api/whatsapp/status-espera.
  // Paginado por segurança: PostgREST limita a 1000 linhas por padrão, inclusive em RPC.
  const ultimaPorLead = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .rpc('get_ultima_mensagem_por_lead', { p_lead_ids: leadIds })
      .range(offset, offset + PAGE - 1)
    if (error) {
      console.error('[monitoramento-resposta] erro na RPC:', error.message)
      return { verificados: 0, notificados: 0 }
    }
    ultimaPorLead.push(...data)
    if (data.length < PAGE) break
  }

  const { data: admins } = await supabase.from('usuarios').select('id').eq('role', 'admin')
  const adminIds = (admins || []).map((a) => a.id)

  let notificados = 0

  for (const item of ultimaPorLead) {
    const lead = leadsPorId.get(item.lead_id)
    if (!lead) continue

    if (item.direcao !== 'entrada') {
      // Cliente já foi respondido — libera o próximo episódio de espera.
      await supabase.from('escalation_log').delete().eq('lead_id', lead.id)
      continue
    }

    const minutos = (agora - new Date(item.created_at).getTime()) / 60000
    let nivelAtual = null
    if (minutos >= LIMIAR_2H) nivelAtual = 3
    else if (minutos >= LIMIAR_30MIN) nivelAtual = 2
    else if (minutos >= LIMIAR_15MIN) nivelAtual = 1
    if (!nivelAtual) continue

    const mensagemId = await buscarUltimaMensagemEntradaId(lead.id)
    const descricao = `${lead.nome} está sem resposta há ${Math.floor(minutos)} minutos.`

    // Dispara todos os níveis até o atual ainda não notificados nesse episódio — se o
    // job ficar parado e o lead pular direto pra 2h, o vendedor ainda recebe o nível 1.
    for (let nivel = 1; nivel <= nivelAtual; nivel++) {
      const { error: logError } = await supabase
        .from('escalation_log')
        .insert({ lead_id: lead.id, level: nivel })

      if (logError) {
        if (logError.code !== '23505') {
          console.error('[monitoramento-resposta] erro ao gravar escalation_log:', logError.message)
        }
        continue // 23505 = já notificado esse nível nesse episódio, segue pro próximo
      }

      const destinatarios = new Set()
      if (nivel === 1) {
        if (lead.responsavel_id) destinatarios.add(lead.responsavel_id)
      } else if (nivel === 2) {
        if (lead.responsavel_id) destinatarios.add(lead.responsavel_id)
        adminIds.forEach((id) => destinatarios.add(id))
      } else {
        adminIds.forEach((id) => destinatarios.add(id))
      }

      for (const userId of destinatarios) {
        const { error: notifError } = await supabase.from('notifications').insert({
          user_id: userId,
          type: 'aguardando_resposta',
          title: TITULOS_POR_NIVEL[nivel],
          description: descricao,
          conversation_id: lead.id,
          message_id: mensagemId,
          escalation_level: nivel,
        })
        if (notifError) {
          console.error('[monitoramento-resposta] erro ao criar notificação:', notifError.message)
          continue
        }
        notificados++
      }
    }
  }

  const resultado = { verificados: leadsAtivos.length, notificados }
  console.log('[monitoramento-resposta] concluído:', resultado)
  return resultado
}
