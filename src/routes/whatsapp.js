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

// GET /api/whatsapp/media/:evolution_id — proxy para download de mídia via Evolution API
// DEVE vir antes de /:lead_id para não ser capturado pelo catch-all
router.get('/media/:evolution_id', async (req, res) => {
  try {
    const { evolution_id } = req.params

    // Busca a mensagem para obter o telefone (remoteJid)
    const { data: registro } = await supabase
      .from('whatsapp_mensagens')
      .select('telefone, direcao')
      .eq('evolution_id', evolution_id)
      .single()

    if (!registro) return res.status(404).json({ erro: 'Mensagem não encontrada' })

    // Busca a mensagem completa no Evolution API para obter as chaves de mídia
    let fullMsg = null
    try {
      const { data: found } = await evolutionApi.post(`/message/findMessages/${INSTANCE}`, {
        where: { key: { id: evolution_id } },
        page: { cursor: 0, limit: 1 },
      })
      fullMsg = found?.messages?.records?.[0] ?? found?.[0] ?? null
    } catch {
      // findMessages pode não estar disponível em todas as versões
    }

    if (!fullMsg) return res.status(404).json({ erro: 'Mídia não disponível no Evolution API' })

    // Download da mídia com descriptografia pelo Evolution API
    const { data: media } = await evolutionApi.post(`/message/downloadMedia/${INSTANCE}`, {
      message: fullMsg,
    })

    if (!media?.base64) return res.status(404).json({ erro: 'Base64 não retornado pelo Evolution API' })

    const mimeType = media.mimetype || 'application/octet-stream'
    const buffer = Buffer.from(media.base64, 'base64')
    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.send(buffer)
  } catch (err) {
    const status = err.response?.status ?? 500
    res.status(status).json({ erro: err.message })
  }
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

// POST /api/whatsapp/enviar-audio — enviar áudio (PTT) via Evolution API
router.post('/enviar-audio', async (req, res) => {
  try {
    const { lead_id, numero, telefone, audio } = req.body
    const destino = numero || telefone
    if (!destino || !audio) {
      return res.status(400).json({ erro: 'Campos "numero" e "audio" são obrigatórios' })
    }

    let numero_limpo = destino.replace(/\D/g, '')
    if (!numero_limpo.startsWith('55')) numero_limpo = '55' + numero_limpo

    const { data: envio } = await evolutionApi.post(`/message/sendWhatsAppAudio/${INSTANCE}`, {
      number: numero_limpo,
      audio,
      encoding: true,
    })

    if (lead_id) {
      await supabase.from('whatsapp_mensagens').insert({
        lead_id,
        mensagem: '[áudio]',
        direcao: 'saida',
        telefone: numero_limpo,
        status: 'enviado',
        evolution_id: envio?.key?.id ?? null,
        media_tipo: 'audio',
      })
    }

    res.json({ sucesso: true, evolution: envio })
  } catch (err) {
    const status = err.response?.status ?? 500
    const mensagem = err.response?.data?.message ?? err.message
    res.status(status).json({ erro: mensagem })
  }
})

// POST /api/whatsapp/enviar-midia — enviar arquivo/imagem via Evolution API
router.post('/enviar-midia', async (req, res) => {
  try {
    const { lead_id, numero, telefone, media, mediatype, mimetype, fileName, caption } = req.body
    const destino = numero || telefone
    if (!destino || !media) {
      return res.status(400).json({ erro: 'Campos "numero" e "media" são obrigatórios' })
    }

    let numero_limpo = destino.replace(/\D/g, '')
    if (!numero_limpo.startsWith('55')) numero_limpo = '55' + numero_limpo

    const { data: envio } = await evolutionApi.post(`/message/sendMedia/${INSTANCE}`, {
      number: numero_limpo,
      mediatype: mediatype || 'document',
      mimetype,
      caption: caption || '',
      media,
      fileName,
    })

    const tipoMap = { image: 'image', video: 'video', document: 'document' }

    if (lead_id) {
      await supabase.from('whatsapp_mensagens').insert({
        lead_id,
        mensagem: caption ? `[arquivo: ${fileName}] ${caption}` : `[arquivo: ${fileName}]`,
        direcao: 'saida',
        telefone: numero_limpo,
        status: 'enviado',
        evolution_id: envio?.key?.id ?? null,
        media_tipo: tipoMap[mediatype] ?? 'document',
      })
    }

    res.json({ sucesso: true, evolution: envio })
  } catch (err) {
    const status = err.response?.status ?? 500
    const mensagem = err.response?.data?.message ?? err.message
    res.status(status).json({ erro: mensagem })
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

export default router
