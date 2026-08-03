import { supabase } from '../lib/supabase-admin.server.js'
import axios from 'axios'

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const PETERSON_NUMERO = '555131372313'
const LIMITE_48H = 48 * 60 * 60 * 1000
const LIMITE_72H = 72 * 60 * 60 * 1000

// CORREÇÃO URGENTE 2026-08-03: a query deste job ficou quebrada "desde sempre"
// (buscava usuarios.telefone, coluna que não existia — corrigido mais cedo hoje).
// Corrigir a query destravou de uma vez um estoque represado de ~1.450 leads
// vencidos, o que geraria quase 2.900 mensagens em rajada pela MESMA instância
// (vivenzza) numa única execução — exatamente o padrão que já suspendeu
// temporariamente a instância financeira em 30/07 com só ~50 mensagens.
// Peterson reportou o risco em tempo real ("vai cair o whatsapp") e o estoque
// represado foi neutralizado direto no banco (handoff_alerta_nivel marcado)
// antes desta correção existir. As proteções abaixo (kill-switch opt-in, teto
// por execução, intervalo entre mensagens) existem pra isso nunca mais
// acontecer, mesmo se handoff_alerta_nivel for resetado por engano no futuro.
// Não afrouxar sem ter certeza de que não vai gerar rajada.
const LIMITE_POR_EXECUCAO = 15 // máx. de leads processados (=~30 msgs) por rodada de cron
const INTERVALO_MIN_MS = 45000
const INTERVALO_MAX_MS = 90000 // 45-90s entre mensagens — nunca rajada, mesmo padrão do cobranca-whatsapp.js

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

// Kill-switch opt-in — igual automacoes_config.cobranca_whatsapp_ativa: uma
// automação que manda WhatsApp sozinha nunca deve ligar por padrão. Só true
// explícito ativa. Default false até o Peterson confirmar e ligar.
async function handoffAlertaEstaAtivo() {
  const { data } = await supabase.from('automacoes_config').select('handoff_alerta_ativo').eq('id', 1).maybeSingle()
  return data?.handoff_alerta_ativo === true
}

function aguardarIntervaloAleatorio() {
  const ms = INTERVALO_MIN_MS + Math.random() * (INTERVALO_MAX_MS - INTERVALO_MIN_MS)
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function enviarWhatsApp(numero, texto) {
  try {
    let dest = numero.replace(/\D/g, '')
    if (!dest.startsWith('55')) dest = '55' + dest
    await evolutionApi.post(`/message/sendText/${INSTANCE}`, { number: dest, text: texto })
    return true
  } catch (err) {
    console.error('[handoff-alerta] erro ao enviar WA:', err.message)
    return false
  }
}

export async function runHandoffAlerta() {
  const ativo = await handoffAlertaEstaAtivo()
  if (!ativo) {
    console.log('[handoff-alerta] desligado em automacoes_config.handoff_alerta_ativo — nada foi verificado')
    return { ativo: false, verificados: 0, alertas_48h: 0, alertas_72h: 0 }
  }

  const agora = Date.now()

  // Busca todos os leads com atendimento_humano=true e responsavel_id definido
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, nome, telefone, responsavel_id, handoff_alerta_nivel, usuarios!leads_responsavel_id_fkey(nome, telefone)')
    .eq('atendimento_humano', true)
    .not('responsavel_id', 'is', null)

  if (error) {
    console.error('[handoff-alerta] erro ao buscar leads:', error.message)
    return { ativo: true, verificados: 0, alertas_48h: 0, alertas_72h: 0 }
  }

  let alertas48 = 0, alertas72 = 0, semTelefoneVendedora = 0, processados = 0
  let paradoPorTeto = false

  for (const lead of leads || []) {
    if (processados >= LIMITE_POR_EXECUCAO) {
      paradoPorTeto = true
      console.warn(`[handoff-alerta] teto de ${LIMITE_POR_EXECUCAO} leads/execução atingido — restante fica pra próxima rodada (proteção anti-rajada)`)
      break
    }

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
      await aguardarIntervaloAleatorio()
      if (telVendedora) {
        await enviarWhatsApp(telVendedora, msg72)
        await aguardarIntervaloAleatorio()
      } else {
        semTelefoneVendedora++
        console.warn(`[handoff-alerta] 72h: ${nomeVendedora} (lead ${lead.id}) sem telefone cadastrado em usuarios — alerta enviado só para o Peterson`)
      }

      await supabase.from('leads').update({ handoff_alerta_nivel: 72 }).eq('id', lead.id)
      alertas72++
      processados++
      console.log(`[handoff-alerta] 72h enviado — lead ${lead.id} (${lead.nome})`)
      continue
    }

    // Alerta 48h: vendedora responsável + cópia pro Peterson (accountability
    // de gestão — enquanto as vendedoras dividem um único número de
    // atendimento, o lembrete se perde no meio das conversas com lead se só
    // for pra lá; o Peterson recebendo também garante que alguém vê a tempo).
    if (msDesdeUltima >= LIMITE_48H && lead.handoff_alerta_nivel < 48) {
      const msg48Peterson = `⏰ *Lembrete de atendimento (48h) — cópia gestão*\n\nLead: *${lead.nome}*\nResponsável: ${nomeVendedora}\n\nEsse lead está há mais de 48 horas sem resposta da vendedora responsável.`
      await enviarWhatsApp(PETERSON_NUMERO, msg48Peterson)
      await aguardarIntervaloAleatorio()

      if (telVendedora) {
        const msg48 = `⏰ *Lembrete de atendimento*\n\nLead: *${lead.nome}*\n\nVocê assumiu este atendimento mas não enviou mensagem há mais de 48 horas. O cliente está esperando!`
        await enviarWhatsApp(telVendedora, msg48)
        await aguardarIntervaloAleatorio()
      } else {
        semTelefoneVendedora++
        console.warn(`[handoff-alerta] 48h: ${nomeVendedora} (lead ${lead.id}) sem telefone cadastrado em usuarios — só o Peterson foi avisado`)
      }

      await supabase.from('leads').update({ handoff_alerta_nivel: 48 }).eq('id', lead.id)
      alertas48++
      processados++
      console.log(`[handoff-alerta] 48h enviado — lead ${lead.id} (${lead.nome})`)
    }
  }

  const resultado = {
    ativo: true,
    verificados: (leads || []).length,
    processados,
    alertas_48h: alertas48,
    alertas_72h: alertas72,
    sem_telefone_vendedora: semTelefoneVendedora,
    parado_por_teto: paradoPorTeto,
  }
  console.log('[handoff-alerta] concluído:', resultado)
  return resultado
}
