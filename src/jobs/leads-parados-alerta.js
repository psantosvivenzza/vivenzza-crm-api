import { supabase } from '../lib/supabase-admin.server.js'
import { enviarTextoFinanceiro } from '../lib/evolutionFinanceiro.js'

// Alerta de leads parados no CRM (2026-10-22, pedido do Peterson).
// 1 mensagem consolidada para o WhatsApp do comercial + 1 cópia para a gestão.
// Nunca rajada: no máximo 2 mensagens por execução, enviadas pela instância
// financeira (não é a instância de vendas, então não há auto-mensagem).
// Desligar: LEADS_PARADOS_ALERTA_ATIVO=false no Railway.
const PETERSON_NUMERO = '555131372313'
const JANELA_DIAS = 7 // só leads recentes; o estoque antigo é tratado à parte, não vira alerta
const PARADO_APOS_HORAS = 2
const MAX_NOMES = 8

function fmt(n) {
  return new Intl.NumberFormat('pt-BR').format(n)
}

export async function runLeadsParadosAlerta() {
  if (process.env.LEADS_PARADOS_ALERTA_ATIVO === 'false') {
    return { ativo: false }
  }

  const agora = Date.now()
  const desde = new Date(agora - JANELA_DIAS * 86400000).toISOString()
  const limite = new Date(agora - PARADO_APOS_HORAS * 3600000).toISOString()

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, nome, created_at, responsavel_id, usuarios!leads_responsavel_id_fkey(nome)')
    .eq('etapa', 'novo')
    .or('campanha_origem.is.null,campanha_origem.neq.site_volte10_20261023')
    .gte('created_at', desde)
    .lt('created_at', limite)
    .order('created_at', { ascending: true })
    .limit(500)
  if (error) {
    console.error('[leads-parados] erro ao buscar leads:', error.message)
    return { ativo: true, erro: error.message }
  }
  if (!leads?.length) {
    console.log('[leads-parados] nenhum lead novo parado — sem alerta')
    return { ativo: true, parados: 0 }
  }

  // Número do WhatsApp do comercial: telefone cadastrado dos vendedores ativos.
  const { data: vend } = await supabase
    .from('usuarios')
    .select('telefone')
    .eq('role', 'vendedor')
    .eq('ativo', true)
    .not('telefone', 'is', null)
  const numeros = [...new Set((vend || []).map((v) => String(v.telefone).replace(/\D/g, '')).filter((t) => t.length >= 10))]
  if (process.env.WHATSAPP_COMERCIAL_NUMBER) numeros.push(process.env.WHATSAPP_COMERCIAL_NUMBER.replace(/\D/g, ''))

  const porResp = new Map()
  for (const l of leads) {
    const nome = l.usuarios?.nome || 'Sem responsável'
    porResp.set(nome, (porResp.get(nome) || 0) + 1)
  }
  const resumo = [...porResp.entries()].map(([n, c]) => `• ${n}: ${fmt(c)}`).join('\n')
  const mais = leads
    .slice(0, MAX_NOMES)
    .map((l) => {
      const h = Math.floor((agora - new Date(l.created_at).getTime()) / 3600000)
      const tempo = h >= 24 ? `${Math.floor(h / 24)}d` : `${h}h`
      return `- ${l.nome || 'Sem nome'} (${tempo})`
    })
    .join('\n')

  const texto =
    `⚠️ *Leads parados no CRM*\n\n` +
    `${fmt(leads.length)} lead(s) dos últimos ${JANELA_DIAS} dias seguem em *Novo* há mais de ${PARADO_APOS_HORAS}h, sem ninguém movimentar.\n\n` +
    `${resumo}\n\nMais antigos:\n${mais}\n\n` +
    `*Ação agora:* chame cada lead no WhatsApp e mova a etapa dentro do CRM (Contatado, Negociação ou Perdido). ` +
    `Lead parado é dinheiro de anúncio jogado fora. Registrou? Movimentou no CRM.`

  const destinos = [...numeros, PETERSON_NUMERO]
  let enviados = 0
  for (const d of destinos) {
    try {
      await enviarTextoFinanceiro(d, texto)
      enviados++
    } catch (err) {
      console.error('[leads-parados] erro ao enviar WA:', err.message)
    }
  }
  const resultado = { ativo: true, parados: leads.length, destinos: destinos.length, enviados }
  console.log('[leads-parados] concluído:', resultado)
  return resultado
}
