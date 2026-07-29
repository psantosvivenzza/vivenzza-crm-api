import { Router } from 'express'
import axios from 'axios'
import { supabase } from '../lib/supabase.js'
import { marcarVendedorAssumiu } from './sdr.js'
import { paraJidWhatsapp } from '../lib/telefone.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

// GET /api/whatsapp/media/:evolution_id — proxy para download de mídia via Evolution API
// DEVE vir antes de /:lead_id para não ser capturado pelo catch-all
router.get('/media/:evolution_id', async (req, res) => {
  try {
    const { evolution_id } = req.params

    // Busca a mensagem com os dados de mídia armazenados no webhook
    const { data: registro } = await supabase
      .from('whatsapp_mensagens')
      .select('telefone, direcao, media_data, media_url')
      .eq('evolution_id', evolution_id)
      .single()

    if (!registro) return res.status(404).json({ erro: 'Mensagem não encontrada' })

    // Só redireciona se for uma URL http(s) de verdade — protege contra valores
    // inválidos que possam ter ficado gravados em media_url (ex: marcador interno),
    // que o navegador tentaria abrir como esquema desconhecido.
    if (/^https?:\/\//.test(registro.media_url || '')) {
      return res.redirect(registro.media_url)
    }

    const md = registro.media_data
    if (!md || !md.mediaKey) {
      return res.status(404).json({ erro: 'Dados de mídia não disponíveis. Mensagem pode ser anterior à atualização do sistema.' })
    }

    const remoteJid = md.remoteJid || `${registro.telefone}@s.whatsapp.net`

    // Reconstrói o objeto de mensagem para /chat/getBase64FromMediaMessage
    const messageObj = {
      key: {
        id: evolution_id,
        remoteJid,
        fromMe: md.fromMe ?? false,
      },
      message: {
        [md.messageType]: {
          url: md.url,
          mediaKey: md.mediaKey,
          mimetype: md.mimetype,
          fileName: md.fileName,
          fileLength: md.fileLength,
          directPath: md.directPath,
          fileEncSha256: md.fileEncSha256,
          fileSha256: md.fileSha256,
        },
      },
    }

    const { data: result } = await evolutionApi.post(
      `/chat/getBase64FromMediaMessage/${INSTANCE}`,
      { message: messageObj }
    )

    if (!result?.base64) return res.status(404).json({ erro: 'Mídia não retornada pelo Evolution API' })

    const mimeType = result.mimetype || md.mimetype || 'application/octet-stream'
    const buffer = Buffer.from(result.base64, 'base64')

    // Salva no Supabase Storage e grava a URL pública real, para que a próxima
    // requisição redirecione direto pra ela em vez de chamar o Evolution API de novo.
    // Fire-and-forget — não aguardamos para não atrasar a resposta.
    ;(async () => {
      try {
        const ext = mimeType.split('/')[1]?.split(';')[0]?.split('+')[0] || 'bin'
        const folder = (md.messageType || 'media').replace('Message', '')
        const path = `${folder}/${evolution_id}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(path, buffer, { contentType: mimeType, upsert: true })
        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('whatsapp-media').getPublicUrl(path)
          await supabase.from('whatsapp_mensagens').update({ media_url: publicUrl }).eq('evolution_id', evolution_id)
        }
      } catch (err) {
        console.error('[whatsapp] erro ao cachear mídia via proxy:', err.message)
      }
    })()

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', `inline; filename="${md.fileName || 'media'}"`)
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.send(buffer)
  } catch (err) {
    const status = err.response?.status ?? 500
    res.status(status).json({ erro: err.message })
  }
})

// GET /api/whatsapp/nao-lidas — contagem de mensagens entrada por lead (últimos 7 dias)
// DEVE vir antes de /:lead_id
// Usa RPC get_nao_lidas() para agregar no banco em vez de buscar todas as linhas —
// reduz de ~2400 linhas / ~2 MB para ~400 linhas de resultado.
router.get('/nao-lidas', async (req, res) => {
  try {
    let leadIds = null
    if (req.user.role === 'vendedor') {
      const { data: meusLeads } = await supabase
        .from('leads')
        .select('id')
        .eq('responsavel_id', req.user.id)
      leadIds = (meusLeads || []).map(l => l.id)
      if (leadIds.length === 0) return res.json({ data: [] })
    }

    const { data, error } = await supabase.rpc('get_nao_lidas', {
      p_lead_ids: leadIds ?? null,
    })
    if (error) throw error

    res.json({ data: data || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/whatsapp/status-espera — direção + horário da última mensagem por lead,
// pra derivar "aguardando_vendedor" (última foi entrada) vs "aguardando_cliente"
// (última foi saída) na lista de conversas. DEVE vir antes de /:lead_id.
router.get('/status-espera', async (req, res) => {
  try {
    let leadIds = null
    if (req.user.role === 'vendedor') {
      const { data: meusLeads } = await supabase
        .from('leads')
        .select('id')
        .eq('responsavel_id', req.user.id)
      leadIds = (meusLeads || []).map(l => l.id)
      if (leadIds.length === 0) return res.json({ data: [] })
    }

    // PostgREST limita a 1000 linhas por padrão — inclusive em RPC — e com 2.400+
    // leads isso trunca silenciosamente sem paginar (mesmo bug já visto em
    // aging.js e no job da régua de cobrança).
    const resultado = []
    const PAGE = 1000
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .rpc('get_ultima_mensagem_por_lead', { p_lead_ids: leadIds ?? null })
        .range(offset, offset + PAGE - 1)
      if (error) throw error
      resultado.push(...data)
      if (data.length < PAGE) break
    }

    res.json({ data: resultado })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/whatsapp/recentes?desde=ISO — mensagens de entrada recentes para polling de notificações
// DEVE vir antes de /:lead_id
router.get('/recentes', async (req, res) => {
  try {
    const { desde } = req.query
    if (!desde) return res.status(400).json({ erro: 'Parâmetro "desde" obrigatório' })

    let leadIds = null

    if (req.user.role === 'vendedor') {
      const { data: meusLeads } = await supabase
        .from('leads')
        .select('id')
        .eq('responsavel_id', req.user.id)
      leadIds = (meusLeads || []).map(l => l.id)
      if (leadIds.length === 0) return res.json({ data: [] })
    }

    let query = supabase
      .from('whatsapp_mensagens')
      .select('id, lead_id, mensagem, telefone, direcao, media_tipo, created_at, leads(id, nome)')
      .eq('direcao', 'entrada')
      .gt('created_at', desde)
      .order('created_at', { ascending: false })
      .limit(20)

    if (leadIds) query = query.in('lead_id', leadIds)

    const { data, error } = await query
    if (error) throw error

    res.json({ data: data || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// Agrupa linhas de message_reactions (message_id, emoji, user_id, usuarios(id,nome))
// em { [message_id]: [{ emoji, count, reactedByCurrentUser, users: [{id, nome}] }] }.
// Compartilhado entre GET /:lead_id (várias mensagens de uma vez) e os endpoints
// de reactions de uma mensagem só.
function agruparReacoesPorMensagem(rows, currentUserId) {
  const porMensagem = new Map()
  for (const r of rows) {
    if (!porMensagem.has(r.message_id)) porMensagem.set(r.message_id, new Map())
    const porEmoji = porMensagem.get(r.message_id)
    if (!porEmoji.has(r.emoji)) {
      porEmoji.set(r.emoji, { emoji: r.emoji, count: 0, reactedByCurrentUser: false, users: [] })
    }
    const grupo = porEmoji.get(r.emoji)
    grupo.count++
    if (r.user_id === currentUserId) grupo.reactedByCurrentUser = true
    grupo.users.push({ id: r.usuarios?.id ?? r.user_id, nome: r.usuarios?.nome ?? null })
  }
  const resultado = {}
  for (const [messageId, porEmoji] of porMensagem) resultado[messageId] = [...porEmoji.values()]
  return resultado
}

async function buscarReacoesDaMensagem(messageId, currentUserId) {
  const { data, error } = await supabase
    .from('message_reactions')
    .select('message_id, emoji, user_id, usuarios(id, nome)')
    .eq('message_id', messageId)
  if (error) throw error
  const agrupado = agruparReacoesPorMensagem(data || [], currentUserId)
  return agrupado[messageId] || []
}

// POST /api/whatsapp/mensagens/:messageId/reactions — reagir a uma mensagem.
// Toggle: clicar na mesma reação remove; clicar em outra substitui (1 reação por
// usuário por mensagem, garantido pelo UNIQUE(message_id, user_id) da migration).
router.post('/mensagens/:messageId/reactions', async (req, res) => {
  try {
    const { messageId } = req.params
    const { emoji } = req.body
    if (!emoji) return res.status(400).json({ erro: 'Campo "emoji" é obrigatório' })
    const userId = req.user.id

    const { data: existente, error: buscaError } = await supabase
      .from('message_reactions')
      .select('id, emoji')
      .eq('message_id', messageId)
      .eq('user_id', userId)
      .maybeSingle()
    if (buscaError) throw buscaError

    if (existente && existente.emoji === emoji) {
      const { error } = await supabase.from('message_reactions').delete().eq('id', existente.id)
      if (error) throw error
    } else {
      const { error } = await supabase
        .from('message_reactions')
        .upsert({ message_id: messageId, user_id: userId, emoji }, { onConflict: 'message_id,user_id' })
      if (error) throw error
    }

    res.json({ data: await buscarReacoesDaMensagem(messageId, userId) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// DELETE /api/whatsapp/mensagens/:messageId/reactions — remove a reação do usuário atual
router.delete('/mensagens/:messageId/reactions', async (req, res) => {
  try {
    const { messageId } = req.params
    const userId = req.user.id
    const { error } = await supabase
      .from('message_reactions')
      .delete()
      .eq('message_id', messageId)
      .eq('user_id', userId)
    if (error) throw error

    res.json({ data: await buscarReacoesDaMensagem(messageId, userId) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/whatsapp/mensagens/:messageId/reactions — reações agrupadas de uma mensagem
router.get('/mensagens/:messageId/reactions', async (req, res) => {
  try {
    res.json({ data: await buscarReacoesDaMensagem(req.params.messageId, req.user.id) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/whatsapp/:lead_id — histórico de mensagens
router.get('/:lead_id', async (req, res) => {
  try {
    const { lead_id } = req.params
    const { page = 1, limit = 50 } = req.query
    const limitNum = Number(limit)
    const offset = (Number(page) - 1) * limitNum

    // Busca em ordem decrescente (mais recentes primeiro) e só depois inverte — em
    // ordem crescente com range(), uma conversa com mais de `limit` mensagens no total
    // retornava sempre as MAIS ANTIGAS, nunca as recentes. Era por isso que uma mensagem
    // recém-enviada aparecia (optimistic update local) e desaparecia ao recarregar do
    // servidor: o servidor nunca devolvia essa mensagem nova pra começo.
    //
    // As mensagens e o telefone do lead são independentes — buscar em paralelo corta
    // ~1/3 do tempo desse endpoint, que é chamado a cada 5s por conversa aberta no chat.
    const [{ data, error, count }, { data: lead }] = await Promise.all([
      supabase
        .from('whatsapp_mensagens')
        .select('*', { count: 'exact' })
        .eq('lead_id', lead_id)
        .order('created_at', { ascending: false })
        .range(offset, offset + limitNum - 1),
      supabase.from('leads').select('telefone, atendimento_humano').eq('id', lead_id).single(),
    ])

    if (error) throw error
    const ordenado = [...(data || [])].reverse()

    // Reações agrupadas por mensagem — uma query só pra todas as mensagens da página,
    // não uma por mensagem.
    let reactionsPorMensagem = {}
    if (ordenado.length > 0) {
      const { data: reacoes, error: reacoesError } = await supabase
        .from('message_reactions')
        .select('message_id, emoji, user_id, usuarios(id, nome)')
        .in('message_id', ordenado.map((m) => m.id))
      if (reacoesError) throw reacoesError
      reactionsPorMensagem = agruparReacoesPorMensagem(reacoes || [], req.user.id)
    }
    const ordenadoComReacoes = ordenado.map((m) => ({ ...m, reactions: reactionsPorMensagem[m.id] || [] }))

    // Status do atendimento (ia_atendendo / vendedor_assumiu / ia_apoio) — usado pelo
    // badge no header do chat, pra Ana/Tatiane saberem se a Lara está respondendo agora.
    // candidatosTelefone() foi feita para o sentido contrário (entrada em formato do
    // WhatsApp, já com "55", gerando variações locais) — aqui o ponto de partida é
    // leads.telefone em formato local, então geramos local + "55"+local pra cada variação
    // de 9º dígito, senão a variante "55"+telefone-como-está nunca é testada.
    let status_atendimento = null
    if (lead?.telefone) {
      // Mesma regra de candidatosTelefone(): só é código de país com 12+ dígitos — com 10/11
      // dígitos "55" inicial é o próprio DDD (Caxias do Sul/RS) e não deve ser removido.
      const temCodigoPais = lead.telefone.length >= 12 && lead.telefone.startsWith('55')
      const semPrefixo = temCodigoPais ? lead.telefone.replace(/^55/, '') : lead.telefone
      const com9 = semPrefixo.length === 10 ? semPrefixo.slice(0, 2) + '9' + semPrefixo.slice(2) : null
      const sem9 = semPrefixo.length === 11 ? semPrefixo.slice(0, 2) + semPrefixo.slice(3) : null
      const locais = [semPrefixo, com9, sem9].filter(Boolean)
      const candidatos = [...locais, ...locais.map((c) => `55${c}`)]

      const { data: conversas } = await supabase
        .from('sdr_conversas')
        .select('status_atendimento')
        .in('telefone', candidatos)
        .order('ultimo_contato', { ascending: false })
        .limit(1)
      status_atendimento = conversas?.[0]?.status_atendimento ?? null
    }

    res.json({ data: ordenadoComReacoes, total: count, page: Number(page), limit: limitNum, status_atendimento, atendimento_humano: lead?.atendimento_humano ?? false })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/whatsapp/enviar-audio — enviar áudio (PTT) via Evolution API
router.post('/enviar-audio', async (req, res) => {
  try {
    const { lead_id, numero, telefone, audio, mimeType } = req.body
    const destino = numero || telefone
    if (!destino || !audio) {
      return res.status(400).json({ erro: 'Campos "numero" e "audio" são obrigatórios' })
    }

    const numero_limpo = paraJidWhatsapp(destino)

    const { data: envio } = await evolutionApi.post(`/message/sendWhatsAppAudio/${INSTANCE}`, {
      number: numero_limpo,
      audio,
      encoding: true,
    })

    await marcarVendedorAssumiu(numero_limpo)

    if (lead_id) {
      await supabase.from('leads').update({ atendimento_humano: true, handoff_alerta_nivel: 0 }).eq('id', lead_id)
    }

    const evolutionId = envio?.key?.id ?? null
    let mediaUrl = null

    // Salva o áudio enviado no Supabase Storage para exibir player imediatamente.
    // Usa o mimeType enviado pelo cliente (ex: audio/webm, audio/ogg) para garantir
    // que o Content-Type no Storage corresponda ao formato real do arquivo.
    if (audio && evolutionId) {
      try {
        const buffer = Buffer.from(audio, 'base64')
        const contentType = mimeType || 'audio/webm'
        const ext = contentType.startsWith('audio/ogg') ? 'ogg' : 'webm'
        const path = `audio/${evolutionId}.${ext}`
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(path, buffer, { contentType, upsert: true })
        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('whatsapp-media').getPublicUrl(path)
          mediaUrl = publicUrl
        }
      } catch (uploadErr) {
        console.error('[enviar-audio] erro upload storage:', uploadErr.message)
      }
    }

    if (lead_id) {
      await supabase.from('whatsapp_mensagens').insert({
        lead_id,
        mensagem: '[áudio]',
        direcao: 'saida',
        telefone: numero_limpo,
        status: 'enviado',
        evolution_id: evolutionId,
        media_tipo: 'audio',
        media_url: mediaUrl,
      })
    }

    res.json({ sucesso: true, media_url: mediaUrl, evolution: envio })
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

    const numero_limpo = paraJidWhatsapp(destino)

    const { data: envio } = await evolutionApi.post(`/message/sendMedia/${INSTANCE}`, {
      number: numero_limpo,
      mediatype: mediatype || 'document',
      mimetype,
      caption: caption || '',
      media,
      fileName,
    })

    await marcarVendedorAssumiu(numero_limpo)

    if (lead_id) {
      await supabase.from('leads').update({ atendimento_humano: true, handoff_alerta_nivel: 0 }).eq('id', lead_id)
    }

    const evolutionId = envio?.key?.id ?? null
    const tipoMap = { image: 'image', video: 'video', document: 'document' }
    const labelMap = { image: '[imagem]', video: '[vídeo]' }
    let mediaUrl = null

    // Upload para Supabase Storage para exibição imediata no chat
    if (media && evolutionId) {
      try {
        const buffer = Buffer.from(media, 'base64')
        const safeFile = (fileName || `file_${evolutionId}`).replace(/[^a-zA-Z0-9._-]/g, '_')
        const storagePath = `${mediatype || 'document'}/${evolutionId}_${safeFile}`
        const { error: uploadError } = await supabase.storage
          .from('whatsapp-media')
          .upload(storagePath, buffer, { contentType: mimetype || 'application/octet-stream', upsert: true })
        if (!uploadError) {
          const { data: { publicUrl } } = supabase.storage.from('whatsapp-media').getPublicUrl(storagePath)
          mediaUrl = publicUrl
        }
      } catch (uploadErr) {
        console.error('[enviar-midia] erro upload storage:', uploadErr.message)
      }
    }

    const msgTexto = labelMap[mediatype]
      ? (caption ? `${labelMap[mediatype]} ${caption}` : labelMap[mediatype])
      : (caption ? `[arquivo: ${fileName}] ${caption}` : `[arquivo: ${fileName}]`)

    if (lead_id) {
      await supabase.from('whatsapp_mensagens').insert({
        lead_id,
        mensagem: msgTexto,
        direcao: 'saida',
        telefone: numero_limpo,
        status: 'enviado',
        evolution_id: evolutionId,
        media_tipo: tipoMap[mediatype] ?? 'document',
        media_url: mediaUrl,
      })
    }

    res.json({ sucesso: true, media_url: mediaUrl, evolution: envio })
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

    const numero_limpo = paraJidWhatsapp(destino)

    const { data: envio } = await evolutionApi.post(`/message/sendText/${INSTANCE}`, {
      number: numero_limpo,
      text: mensagem,
    })

    await marcarVendedorAssumiu(numero_limpo)

    if (lead_id) {
      await supabase.from('leads').update({ atendimento_humano: true, handoff_alerta_nivel: 0 }).eq('id', lead_id)
    }

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
