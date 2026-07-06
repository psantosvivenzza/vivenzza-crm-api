import { supabase } from '../lib/supabase.js'
import axios from 'axios'

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const PETERSON_NUMERO = '555131372313'
const LIMITE_48H = 48 * 60 * 60 * 1000
const LIMITE_72H = 72 * 60 * 60 * 1000

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

async function enviarWhatsApp(numero, texto) {
  try {
    let dest = numero.replace(/\D/g, '')
    if (!dest.startsWith('55')) dest = '55' + dest
    await evolutionApi.post(`/message/sendText/${INSTANCE}`, { number: dest, text: texto })
  } catch (err) {
    console.error('[handoff-alerta] erro ao enviar WA:', err.message)
  }
}

export async function runHandoffAlerta() {
  const agora = Date.now()

  // Busca todos os leads com atendimento_humano=true e responsavel_id definido
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, nome, telefone, responsavel_id, handoff_alerta_nivel, usuarios!leads_responsavel_id_fkey(nome, telefone)')
    .eq('atendimento_humano', true)
    .not('responsavel_id', 'is', null)

  if (error) {
    console.error('[handoff-alerta] erro ao buscar leads:', error.message)
    return { verificados: 0, alertas_48h: 0, alertas_72h: 0 }
  }

  let alertas48 = 0, alertas72 = 0

  for (const lead of leads || []) {
    // Busca última mensagem de saída para este lead
    const { data: msgs } = await supabase
      .from('whatsapp_mensagens')
      .select('created_at')
      .eq('lead_id', lead.id)
      .eq('direcao', 'saida')
      .order('created_at', { ascending: false })
      .limit(1)

    const ultimaSaida = msgs?.[0]?.created_at ? new Date(msgs[0].created_at).getTime() : null
    const msDesdeUltima = ultimaSaida ? agora - ultimaSaida : Infinity

    const nomeVendedora = lead.usuarios?.nome || 'Vendedora'
    const telVendedora = lead.usuarios?.telefone

    // Alerta 72h: escala para Peterson + vendedora
    if (msDesdeUltima >= LIMITE_72H && lead.handoff_alerta_nivel < 72) {
      const msg72 = `⚠️ *Handoff sem resposta há 72h*\n\nLead: *${lead.nome}*\nResponsável: ${nomeVendedora}\n\nO cliente não recebeu mensagem há mais de 72 horas. Ação imediata necessária.`

      await enviarWhatsApp(PETERSON_NUMERO, msg72)
      if (telVendedora) await enviarWhatsApp(telVendedora, msg72)

      await supabase.from('leads').update({ handoff_alerta_nivel: 72 }).eq('id', lead.id)
      alertas72++
      console.log(`[handoff-alerta] 72h enviado — lead ${lead.id} (${lead.nome})`)
      continue
    }

    // Alerta 48h: só para a vendedora responsável
    if (msDesdeUltima >= LIMITE_48H && lead.handoff_alerta_nivel < 48) {
      if (telVendedora) {
        const msg48 = `⏰ *Lembrete de atendimento*\n\nLead: *${lead.nome}*\n\nVocê assumiu este atendimento mas não enviou mensagem há mais de 48 horas. O cliente está esperando!`
        await enviarWhatsApp(telVendedora, msg48)
      }

      await supabase.from('leads').update({ handoff_alerta_nivel: 48 }).eq('id', lead.id)
      alertas48++
      console.log(`[handoff-alerta] 48h enviado — lead ${lead.id} (${lead.nome})`)
    }
  }

  const resultado = { verificados: (leads || []).length, alertas_48h: alertas48, alertas_72h: alertas72 }
  console.log('[handoff-alerta] concluído:', resultado)
  return resultado
}
