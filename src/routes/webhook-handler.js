import { supabase } from '../lib/supabase.js'

function detectarCampanha(texto) {
  const t = (texto || '').toUpperCase()
  if (t.includes('CIDADESRS')) return 'campanha_cidadesrs'
  if (t.includes('B2B'))       return 'campanha_b2b'
  if (t.includes('LISTA'))     return 'campanha_lista'
  return 'whatsapp'
}

// Detecta se a mensagem veio de um anúncio do Meta Ads (Click-to-WhatsApp)
function detectarAnuncio(msg) {
  const ref = msg.referral
  if (ref) {
    const id = ref.source_id || ref.sourceId || ''
    const titulo = ref.headline || ref.body || ''
    const label = (titulo || id || 'ads').slice(0, 60).replace(/\s+/g, '_')
    console.log('[webhook] Meta Ads referral detectado:', JSON.stringify(ref))
    return `meta_${label}`
  }
  const tipos = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'buttonsMessage']
  for (const tipo of tipos) {
    const adReply = msg.message?.[tipo]?.contextInfo?.externalAdReply
    if (adReply) {
      const id = adReply.sourceId || ''
      const titulo = adReply.title || adReply.body || ''
      const label = (titulo || id || 'ads').slice(0, 60).replace(/\s+/g, '_')
      console.log('[webhook] Meta Ads externalAdReply detectado:', JSON.stringify(adReply))
      return `meta_${label}`
    }
  }
  return null
}

// Detecta tipo de mídia, texto descritivo e extrai dados para download posterior
function detectarMidia(msg) {
  const messageType = msg.messageType || Object.keys(msg.message || {}).find(k => k !== 'messageContextInfo') || ''
  const map = {
    audioMessage:                   { tipo: 'audio',    texto: '[áudio]' },
    ptvMessage:                     { tipo: 'video',    texto: '[vídeo curto]' },
    videoMessage:                   { tipo: 'video',    texto: '[vídeo]' },
    imageMessage:                   { tipo: 'image',    texto: '[imagem]' },
    stickerMessage:                 { tipo: 'sticker',  texto: '[figurinha]' },
    documentMessage:                { tipo: 'document', texto: `[arquivo: ${msg.message?.documentMessage?.fileName || 'documento'}]` },
    documentWithCaptionMessage:     { tipo: 'document', texto: `[arquivo: ${msg.message?.documentWithCaptionMessage?.message?.documentMessage?.fileName || 'documento'}]` },
  }
  const info = map[messageType] ?? null
  if (!info) return null

  // Extrai os campos necessários para /chat/getBase64FromMediaMessage
  const mediaObj = msg.message?.[messageType] ?? {}
  const mediaData = {
    messageType,
    remoteJid: msg.key?.remoteJid,
    fromMe: msg.key?.fromMe ?? false,
    url: mediaObj.url,
    mediaKey: mediaObj.mediaKey,
    mimetype: mediaObj.mimetype,
    fileName: mediaObj.fileName || mediaObj.title,
    fileLength: mediaObj.fileLength,
    directPath: mediaObj.directPath,
    fileEncSha256: mediaObj.fileEncSha256,
    fileSha256: mediaObj.fileSha256,
  }

  return { ...info, mediaData }
}

// Mapeia código de status do WhatsApp para texto
function mapStatus(code) {
  const map = { 1: 'pendente', 2: 'enviado', 3: 'entregue', 4: 'lido', 5: 'reproduzido' }
  return map[code] ?? null
}

async function proximoVendedor() {
  const { data: vendedores } = await supabase
    .from('usuarios')
    .select('id, nome')
    .eq('role', 'vendedor')
    .eq('ativo', true)
    .order('nome', { ascending: true })

  if (!vendedores || vendedores.length === 0) return null

  const { data: fila } = await supabase
    .from('distribuicao_leads')
    .select('ultimo_vendedor_id')
    .eq('id', 1)
    .single()

  const ultimoId = fila?.ultimo_vendedor_id ?? null
  const idx = vendedores.findIndex(v => v.id === ultimoId)
  const proximo = vendedores[(idx + 1) % vendedores.length]

  await supabase
    .from('distribuicao_leads')
    .update({ ultimo_vendedor_id: proximo.id, updated_at: new Date().toISOString() })
    .eq('id', 1)

  return proximo
}

export default async function handleWebhook(req, res) {
  try {
    const payload = req.body
    console.log('[webhook] event:', payload.event, '| data keys:', Object.keys(payload.data || {}))

    // ── Status de entrega/leitura ──────────────────────────────────────────
    if (payload.event === 'messages.update') {
      const updates = Array.isArray(payload.data) ? payload.data : [payload.data]
      for (const upd of updates) {
        const msgId = upd.key?.id
        const novoStatus = mapStatus(upd.update?.status)
        if (msgId && novoStatus) {
          await supabase
            .from('whatsapp_mensagens')
            .update({ status: novoStatus })
            .eq('evolution_id', msgId)
          console.log('[webhook] status atualizado:', msgId.slice(0, 12), '→', novoStatus)
        }
      }
      return res.sendStatus(200)
    }

    if (payload.event !== 'messages.upsert') return res.sendStatus(200)

    const msg = Array.isArray(payload.data) ? payload.data[0] : payload.data
    if (!msg) return res.sendStatus(200)

    // Log completo para inspecionar payload de anúncios Meta Ads e mídias
    console.log('[webhook] msg completo:', JSON.stringify(msg).slice(0, 1500))

    const fromMe = msg.key?.fromMe === true
    const remoteJid = msg.key?.remoteJid ?? ''
    const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '')

    const midia = detectarMidia(msg)
    const texto =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      midia?.texto ??
      '[mídia]'
    const mediaTipo = midia?.tipo ?? null
    const mediaData = midia?.mediaData ?? null

    const direcao = fromMe ? 'saida' : 'entrada'
    const status = fromMe ? 'enviado' : 'recebido'
    console.log('[webhook]', direcao, '| tel:', telefone, '| tipo:', mediaTipo ?? 'texto', '|', texto.slice(0, 50))

    const semPrefixo = telefone.replace(/^55/, '')
    const com9 = semPrefixo.length === 10 ? semPrefixo.slice(0, 2) + '9' + semPrefixo.slice(2) : null
    const sem9 = semPrefixo.length === 11 ? semPrefixo.slice(0, 2) + semPrefixo.slice(3) : null
    const candidatos = [telefone, semPrefixo, com9, sem9].filter(Boolean)

    const { data: leads } = await supabase
      .from('leads')
      .select('id, telefone')
      .in('telefone', candidatos)
      .limit(1)

    let lead = leads?.[0] ?? null

    if (!lead && !fromMe) {
      const vendedor = await proximoVendedor()
      const origem = detectarAnuncio(msg) ?? detectarCampanha(texto)
      const { data: novoLead, error } = await supabase
        .from('leads')
        .insert({
          nome: `Lead WhatsApp ${semPrefixo}`,
          telefone: semPrefixo,
          etapa: 'novo',
          origem,
          responsavel_id: vendedor?.id ?? null,
        })
        .select('id, nome, responsavel_id')
        .single()

      if (!error && novoLead) {
        lead = novoLead
        console.log('[webhook] novo lead criado:', novoLead.nome, '→ vendedor:', vendedor?.nome, '| origem:', origem)
      } else {
        console.error('[webhook] erro ao criar lead:', error?.message)
      }
    }

    await supabase.from('whatsapp_mensagens').insert({
      lead_id: lead?.id ?? null,
      mensagem: texto,
      direcao,
      telefone,
      status,
      evolution_id: msg.key?.id ?? null,
      media_tipo: mediaTipo,
      media_data: mediaData,
    })

    res.sendStatus(200)
  } catch (err) {
    console.error('[webhook] erro:', err.message, '| body:', JSON.stringify(req.body).slice(0, 200))
    res.sendStatus(200)
  }
}
