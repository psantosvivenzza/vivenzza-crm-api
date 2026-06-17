import { Router } from 'express'
import axios from 'axios'
import { supabase } from '../lib/supabase.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || 'vivenzza2026'
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
})

// GET /api/whatsapp/:lead_id — histórico de mensagens
router.get('/:lead_id', async (req, res) => {
  try {
    const { lead_id } = req.params
    const { page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    const { data, error, count } = await supabase
      .from('whatsapp_mensagens')
      .select('*', { count: 'exact' })
      .eq('lead_id', lead_id)
      .order('created_at', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/whatsapp/enviar — enviar mensagem via Evolution API
router.post('/enviar', async (req, res) => {
  try {
    const { lead_id, numero, telefone, mensagem } = req.body
    const destino = numero || telefone

    if (!destino || !mensagem) {
      return res.status(400).json({ erro: 'Campos "numero" e "mensagem" são obrigatórios' })
    }

    let numero_limpo = destino.replace(/\D/g, '')
    // Garante prefixo 55 (Brasil) se não tiver DDI
    if (!numero_limpo.startsWith('55')) numero_limpo = '55' + numero_limpo

    const { data: envio } = await evolutionApi.post(`/message/sendText/${INSTANCE}`, {
      number: numero_limpo,
      text: mensagem,
    })

    if (lead_id) {
      await supabase.from('whatsapp_mensagens').insert({
        lead_id,
        mensagem,
        direcao: 'saida',
        telefone: numero_limpo,
        status: 'enviado',
        evolution_id: envio?.key?.id ?? null,
      })
    }

    res.json({ sucesso: true, evolution: envio })
  } catch (err) {
    const status = err.response?.status ?? 500
    const mensagem = err.response?.data?.message ?? err.message
    res.status(status).json({ erro: mensagem })
  }
})

// Handler do webhook exportado — usado diretamente em index.js sem auth
export async function handleWebhook(req, res) {
  try {
    const payload = req.body

    if (payload.event !== 'messages.upsert') return res.sendStatus(200)

    const msg = payload.data?.messages?.[0]
    if (!msg || msg.key?.fromMe) return res.sendStatus(200)

    const telefone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '') ?? ''
    const texto = msg.message?.conversation
      ?? msg.message?.extendedTextMessage?.text
      ?? '[mídia]'

    // Tenta associar ao lead pelo telefone (com e sem prefixo 55)
    const { data: lead } = await supabase
      .from('leads')
      .select('id')
      .or(`telefone.eq.${telefone},telefone.eq.${telefone.replace(/^55/, '')}`)
      .maybeSingle()

    await supabase.from('whatsapp_mensagens').insert({
      lead_id: lead?.id ?? null,
      mensagem: texto,
      direcao: 'entrada',
      telefone,
      status: 'recebido',
      evolution_id: msg.key?.id ?? null,
    })

    res.sendStatus(200)
  } catch (err) {
    console.error('[webhook]', err.message)
    res.sendStatus(200)
  }
}

router.post('/webhook', handleWebhook)

export default router
