import { Router } from 'express'
import axios from 'axios'
import cron from 'node-cron'
import Anthropic from '@anthropic-ai/sdk'
import { supabase } from '../lib/supabase.js'
import { marcarVendedorAssumiu } from '../lib/sdrConversas.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || 'vivenzza2026'
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const TIPOS_ELEGIVEIS = ['salao', 'distribuidor', 'consumidor_final', 'cliente_antigo']
const MAX_TENTATIVAS = 3
const DIAS_SEM_RESPOSTA = 15
const DIAS_ENTRE_FOLLOWUPS = 7

// Janela de envio — fora dela a automação nunca dispara mensagem, mesmo se o job for
// forçado manualmente pelo botão "Executar agora".
function dentroDaJanelaReativacao() {
  const agora = new Date()
  const diaSemana = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' })
  const diaUtil = ['segunda', 'terça', 'quarta', 'quinta', 'sexta'].some((d) => diaSemana.includes(d))
  const hora = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
  return diaUtil && hora >= '09:00' && hora <= '17:30'
}

async function reativacaoEstaAtiva() {
  const { data } = await supabase.from('automacoes_config').select('reativacao_ativa').eq('id', 1).maybeSingle()
  return data?.reativacao_ativa !== false
}

// Soma 1 num contador do dia em reativacao_metricas — lê e regrava porque é um job
// sequencial de baixo volume (não precisa de upsert atômico via RPC).
async function incrementarMetrica(campo, quantidade = 1) {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }) // YYYY-MM-DD
  const { data: existente } = await supabase.from('reativacao_metricas').select('*').eq('data', hoje).maybeSingle()
  if (existente) {
    await supabase.from('reativacao_metricas').update({ [campo]: (existente[campo] ?? 0) + quantidade }).eq('id', existente.id)
  } else {
    await supabase.from('reativacao_metricas').insert({ data: hoje, [campo]: quantidade })
  }
}

// leads.telefone está em formato local — gera as mesmas variações de 9º dígito, mais
// "55"+variante, pro lookup em sdr_conversas (que guarda telefone em formato de JID).
function candidatosParaSdrConversas(telefoneLocal) {
  const semPrefixo = telefoneLocal.replace(/^55/, '')
  const com9 = semPrefixo.length === 10 ? semPrefixo.slice(0, 2) + '9' + semPrefixo.slice(2) : null
  const sem9 = semPrefixo.length === 11 ? semPrefixo.slice(0, 2) + semPrefixo.slice(3) : null
  const locais = [semPrefixo, com9, sem9].filter(Boolean)
  return [...locais, ...locais.map((c) => `55${c}`)]
}

async function statusAtendimentoDoLead(telefoneLocal) {
  const candidatos = candidatosParaSdrConversas(telefoneLocal)
  const { data } = await supabase
    .from('sdr_conversas')
    .select('status_atendimento')
    .in('telefone', candidatos)
    .order('ultimo_contato', { ascending: false })
    .limit(1)
  return data?.[0]?.status_atendimento ?? null
}

function extrairTextoClaude(resposta) {
  return resposta?.content?.[0]?.text?.trim() ?? ''
}

async function gerarMensagemReativacao(lead, tentativa, diasParado, contexto) {
  const prompt = `Você é a SDR da Vivenzza Professional.
Gere UMA mensagem curta de reativação para WhatsApp (máximo 3 linhas).
Tom: humano, consultivo, sem pressão, sem parecer robô.

Lead: ${lead.nome}
Tipo: ${lead.tipo} (salao/distribuidor/consumidor_final/cliente_antigo)
Tentativa: ${tentativa} de ${MAX_TENTATIVAS}
Última interação: ${diasParado} dias atrás
Contexto: ${contexto}

TENTATIVA 1: tom leve, reabrir conversa suavemente
TENTATIVA 2: entregar valor ou novidade consultiva
TENTATIVA 3: fechamento elegante e respeitoso

Retorne APENAS o texto da mensagem, sem aspas, sem explicação.`

  const resposta = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  })
  return extrairTextoClaude(resposta).replace(/^"|"$/g, '')
}

async function ultimasMensagens(leadId, limite) {
  const { data } = await supabase
    .from('whatsapp_mensagens')
    .select('direcao, mensagem, created_at')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(limite)
  return (data || []).reverse()
}

function resumirHistorico(mensagens) {
  return mensagens.map((m) => `${m.direcao === 'entrada' ? 'Cliente' : 'Vivenzza'}: ${m.mensagem}`).join('\n') || '(sem histórico)'
}

async function enviarMensagemReativacao(lead) {
  if (!dentroDaJanelaReativacao()) return null // não envia fora do horário/dia útil

  const tentativa = (lead.qtd_followups_automaticos ?? 0) + 1
  const diasParado = Math.floor((Date.now() - new Date(lead.ultima_mensagem_em).getTime()) / 86400000)
  const contexto = resumirHistorico(await ultimasMensagens(lead.id, 3))

  let numeroLimpo = lead.telefone.replace(/\D/g, '')
  if (!numeroLimpo.startsWith('55')) numeroLimpo = `55${numeroLimpo}`

  try {
    const mensagem = await gerarMensagemReativacao(lead, tentativa, diasParado, contexto)
    if (!mensagem) throw new Error('Claude retornou mensagem vazia')

    const { data: envio } = await evolutionApi.post(`/message/sendText/${EVOLUTION_INSTANCE}`, {
      number: numeroLimpo,
      text: mensagem,
    })

    const novaQtd = tentativa
    const novoStatusReativacao = 'ativo'

    await supabase.from('leads').update({
      ultimo_followup_automatico: new Date().toISOString(),
      qtd_followups_automaticos: novaQtd,
      status_reativacao: novoStatusReativacao,
    }).eq('id', lead.id)

    await supabase.from('reativacao_fila').insert({
      lead_id: lead.id,
      telefone: numeroLimpo,
      tentativa,
      status: 'enviado',
      mensagem_enviada: mensagem,
      enviado_em: new Date().toISOString(),
    })

    await supabase.from('whatsapp_mensagens').insert({
      lead_id: lead.id,
      mensagem,
      direcao: 'saida',
      telefone: numeroLimpo,
      status: 'enviado',
      evolution_id: envio?.key?.id ?? null,
    })

    await incrementarMetrica('enviados')
    console.log(`[reativacao] mensagem enviada para ${lead.nome} (tentativa ${tentativa}/${MAX_TENTATIVAS})`)
    return { lead, tentativa, mensagem }
  } catch (err) {
    await supabase.from('reativacao_fila').insert({
      lead_id: lead.id,
      telefone: numeroLimpo,
      tentativa,
      status: 'erro',
    })
    console.error(`[reativacao] erro ao enviar para ${lead.nome}:`, err.response?.data ? JSON.stringify(err.response.data) : err.message)
    return null
  }
}

export async function verificarElegiveis() {
  if (!(await reativacaoEstaAtiva())) {
    console.log('[reativacao] automação desativada em /automacoes — pulando job de hoje')
    return { elegiveis: 0, enviados: 0 }
  }

  // Tentativa 3 já foi enviada há tempo suficiente e o lead nunca respondeu — encerra
  // o ciclo de nutrição em vez de deixá-lo "ativo" indefinidamente.
  await supabase
    .from('leads')
    .update({ status_reativacao: 'inativo_nutricao' })
    .eq('status_reativacao', 'ativo')
    .gte('qtd_followups_automaticos', MAX_TENTATIVAS)

  const limiteUltimaMensagem = new Date(Date.now() - DIAS_SEM_RESPOSTA * 86400000).toISOString()
  const limiteFollowup = new Date(Date.now() - DIAS_ENTRE_FOLLOWUPS * 86400000).toISOString()

  const { data: candidatos, error } = await supabase
    .from('leads')
    .select('id, nome, telefone, tipo, etapa, responsavel_id, ultima_mensagem_em, ultimo_followup_automatico, qtd_followups_automaticos, status_reativacao')
    .lte('ultima_mensagem_em', limiteUltimaMensagem)
    .not('status_reativacao', 'in', '(encerrado,inativo_nutricao)')
    .lt('qtd_followups_automaticos', MAX_TENTATIVAS)
    .not('telefone', 'is', null)
    .neq('telefone', '')
    .in('tipo', TIPOS_ELEGIVEIS)
    .or(`ultimo_followup_automatico.is.null,ultimo_followup_automatico.lte.${limiteFollowup}`)

  if (error) {
    console.error('[reativacao] erro ao buscar elegíveis:', error.message)
    return { elegiveis: 0, enviados: 0 }
  }

  // status_atendimento mora em sdr_conversas (por telefone), não em leads — filtra
  // fora qualquer lead que o vendedor já assumiu manualmente.
  const elegiveis = []
  for (const lead of candidatos || []) {
    const statusAtendimento = await statusAtendimentoDoLead(lead.telefone)
    if (statusAtendimento !== 'vendedor_assumiu') elegiveis.push(lead)
  }

  await incrementarMetrica('elegiveis', elegiveis.length)
  console.log(`[reativacao] ${elegiveis.length} leads elegíveis hoje`)

  let enviados = 0
  for (const lead of elegiveis) {
    const resultado = await enviarMensagemReativacao(lead)
    if (resultado) enviados++
  }

  return { elegiveis: elegiveis.length, enviados }
}

// Chamado pelo webhook-handler.js quando chega mensagem de um lead com
// status_reativacao = 'ativo' — é a resposta do cliente a um follow-up automático.
export async function detectarRespostaReativacao(leadId, mensagem) {
  try {
    const { data: lead } = await supabase.from('leads').select('*').eq('id', leadId).single()
    if (!lead || lead.status_reativacao !== 'ativo') return

    await supabase.from('leads').update({ status_reativacao: 'reativado' }).eq('id', leadId)

    await supabase
      .from('reativacao_fila')
      .update({ status: 'respondeu', respondeu_em: new Date().toISOString() })
      .eq('lead_id', leadId)
      .eq('status', 'enviado')
      .order('criado_em', { ascending: false })
      .limit(1)

    const historico = resumirHistorico(await ultimasMensagens(leadId, 5))

    const prompt = `Gere um resumo interno para o vendedor sobre este lead reativado.
Nome: ${lead.nome}
Tipo: ${lead.tipo}
Histórico: ${historico}
Resposta que reativou: ${mensagem}

Retorne JSON com:
{
  "resumo": "texto curto do contexto",
  "ultima_intencao": "o que o cliente queria",
  "melhor_proxima_acao": "sugestão para o vendedor",
  "prioridade": "baixo/medio/alto"
}

Retorne APENAS o JSON, sem markdown, sem explicação.`

    const resposta = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    })

    let resumo
    try {
      resumo = JSON.parse(extrairTextoClaude(resposta).replace(/^```json|```$/g, '').trim())
    } catch {
      resumo = { resumo: extrairTextoClaude(resposta), ultima_intencao: '', melhor_proxima_acao: '', prioridade: 'medio' }
    }

    const diasParado = lead.ultima_mensagem_em
      ? Math.floor((Date.now() - new Date(lead.ultima_mensagem_em).getTime()) / 86400000)
      : '?'

    await supabase.from('tarefas').insert({
      lead_id: leadId,
      titulo: `🔄 Lead reativado — ${lead.nome} respondeu após ${diasParado} dias`,
      descricao: [
        resumo.resumo,
        resumo.ultima_intencao ? `Intenção: ${resumo.ultima_intencao}` : null,
        resumo.melhor_proxima_acao ? `Sugestão: ${resumo.melhor_proxima_acao}` : null,
        resumo.prioridade ? `Prioridade: ${resumo.prioridade}` : null,
      ].filter(Boolean).join('\n'),
      prazo: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      tipo: 'whatsapp',
      status: 'pendente',
      responsavel_id: lead.responsavel_id,
    })

    await marcarVendedorAssumiu(lead.telefone)

    await incrementarMetrica('responderam')
    await incrementarMetrica('reativados')
    await incrementarMetrica('passados_vendedor')
    console.log(`[reativacao] lead ${lead.nome} respondeu e foi passado pro vendedor`)
  } catch (err) {
    console.error('[reativacao] erro ao detectar resposta:', err.message)
  }
}

// GET /api/reativacao/status — métricas do dia + estado da automação (admin only,
// auth/adminOnly já aplicados no index.js)
router.get('/status', async (req, res) => {
  try {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
    const { data: metricas } = await supabase.from('reativacao_metricas').select('*').eq('data', hoje).maybeSingle()
    const { data: config } = await supabase.from('automacoes_config').select('reativacao_ativa').eq('id', 1).maybeSingle()

    const proximoDisparo = new Date()
    proximoDisparo.setUTCHours(12, 0, 0, 0) // 09:00 America/Sao_Paulo = 12:00 UTC
    if (proximoDisparo.getTime() <= Date.now()) proximoDisparo.setUTCDate(proximoDisparo.getUTCDate() + 1)

    res.json({
      ativo: config?.reativacao_ativa !== false,
      proximo_disparo: proximoDisparo.toISOString(),
      elegiveis_hoje: metricas?.elegiveis ?? 0,
      enviados_hoje: metricas?.enviados ?? 0,
      responderam_hoje: metricas?.responderam ?? 0,
      passados_vendedor_hoje: metricas?.passados_vendedor ?? 0,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/reativacao/toggle — ativa/desativa a automação
router.post('/toggle', async (req, res) => {
  try {
    const { data: config } = await supabase.from('automacoes_config').select('reativacao_ativa').eq('id', 1).maybeSingle()
    const { data, error } = await supabase
      .from('automacoes_config')
      .update({ reativacao_ativa: !(config?.reativacao_ativa !== false), atualizado_em: new Date().toISOString() })
      .eq('id', 1)
      .select()
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/reativacao/executar-agora — força o job manualmente (admin only)
router.post('/executar-agora', async (req, res) => {
  try {
    const resultado = await verificarElegiveis()
    res.json({ sucesso: true, ...resultado })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// Todo dia útil às 09:00 horário de Brasília
cron.schedule('0 9 * * 1-5', () => {
  verificarElegiveis().catch((err) => console.error('[reativacao] erro no job agendado:', err.message))
}, { timezone: 'America/Sao_Paulo' })

export default router
