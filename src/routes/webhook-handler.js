import axios from 'axios'
import { supabase } from '../lib/supabase.js'
import { candidatosTelefone } from '../lib/telefone.js'
import { detectarRespostaReativacao } from './reativacao.js'

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY || 'vivenzza2026'
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 20000,
})

function detectarCampanha(texto) {
  const t = (texto || '').toUpperCase()
  if (t.includes('CIDADESRS')) return 'campanha_cidadesrs'
  if (t.includes('B2B'))       return 'campanha_b2b'
  if (t.includes('LISTA'))     return 'campanha_lista'
  return 'whatsapp'
}

// Retorna o valor padronizado de campanha_origem para o novo lead:
// Prioridade: referral Meta Ads > externalAdReply > keyword no texto > whatsapp_organico.
function detectarCampanhaOrigem(msg, texto) {
  const mapearConteudoAd = (conteudo) => {
    const c = conteudo.toUpperCase()
    if (c.includes('B2B') || c.includes('REGIAO') || c.includes('REGIOES') || c.includes('REGIÕES')) return 'b2b_regioes'
    if (c.includes('LISTA') || c.includes('BRASIL')) return 'lista_brasil'
    if (c.includes('CIDADESRS') || c.includes('CIDADES RS')) return 'cidadesrs'
    return null
  }

  // Sinal primário: Meta Ads click-to-WhatsApp via referral object
  const ref = msg.referral
  if (ref) {
    const conteudoRef = [ref.headline, ref.body, ref.source_id].filter(Boolean).join(' ')
    const campanha = mapearConteudoAd(conteudoRef)
    if (campanha) return campanha
    const titulo = (ref.headline || ref.body || '').slice(0, 80).trim()
    return titulo || 'meta_ads'
  }

  // Sinal secundário: anúncio via externalAdReply (contexto de mensagem)
  const tiposMsg = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'buttonsMessage']
  for (const tipoMsg of tiposMsg) {
    const adReply = msg.message?.[tipoMsg]?.contextInfo?.externalAdReply
    if (adReply) {
      const conteudoAd = [adReply.title, adReply.body].filter(Boolean).join(' ')
      const campanha = mapearConteudoAd(conteudoAd)
      if (campanha) return campanha
      const titulo = (adReply.title || '').slice(0, 80).trim()
      return titulo || 'meta_ads'
    }
  }

  // Fallback: keyword no texto da primeira mensagem
  const t = (texto || '').toUpperCase()
  if (t.includes('CIDADESRS')) return 'cidadesrs'
  if (t.includes('B2B'))       return 'b2b_regioes'
  if (t.includes('LISTA'))     return 'lista_brasil'

  return 'whatsapp_organico'
}

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

function detectarMidia(msg, conteudo) {
  const messageType = msg.messageType || Object.keys(conteudo || {}).find(k => k !== 'messageContextInfo') || ''
  const map = {
    audioMessage:               { tipo: 'audio',    texto: '[áudio]' },
    ptvMessage:                 { tipo: 'video',    texto: '[vídeo curto]' },
    videoMessage:               { tipo: 'video',    texto: '[vídeo]' },
    imageMessage:               { tipo: 'image',    texto: '[imagem]' },
    stickerMessage:             { tipo: 'sticker',  texto: '[figurinha]' },
    documentMessage:            { tipo: 'document', texto: `[arquivo: ${conteudo?.documentMessage?.fileName || 'documento'}]` },
    documentWithCaptionMessage: { tipo: 'document', texto: `[arquivo: ${conteudo?.documentWithCaptionMessage?.message?.documentMessage?.fileName || 'documento'}]` },
  }
  const info = map[messageType] ?? null
  if (!info) return null

  const mediaObj = conteudo?.[messageType] ?? {}
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

function mapStatus(code) {
  const map = {
    1: 'pendente', 2: 'enviado', 3: 'entregue', 4: 'lido', 5: 'reproduzido',
    PENDING: 'pendente', SERVER_ACK: 'enviado', DELIVERY_ACK: 'entregue', READ: 'lido', PLAYED: 'reproduzido',
  }
  return map[code] ?? null
}

// Baixa mídia via Evolution API e salva no Supabase Storage (fire-and-forget)
async function baixarEArmazenarMidia(evolutionId, mediaData) {
  try {
    if (!mediaData?.mediaKey || !mediaData?.messageType) {
      console.log('[webhook] mídia sem mediaKey — download ignorado:', evolutionId)
      return
    }

    const messageObj = {
      key: {
        id: evolutionId,
        remoteJid: mediaData.remoteJid,
        fromMe: mediaData.fromMe ?? false,
      },
      message: {
        [mediaData.messageType]: {
          url: mediaData.url,
          mediaKey: mediaData.mediaKey,
          mimetype: mediaData.mimetype,
          fileName: mediaData.fileName,
          fileLength: mediaData.fileLength,
          directPath: mediaData.directPath,
          fileEncSha256: mediaData.fileEncSha256,
          fileSha256: mediaData.fileSha256,
        },
      },
    }

    const { data: result } = await evolutionApi.post(
      `/chat/getBase64FromMediaMessage/${INSTANCE}`,
      { message: messageObj }
    )

    if (!result?.base64) {
      console.log('[webhook] Evolution API não retornou base64 para:', evolutionId)
      return
    }

    const mimeType = result.mimetype || mediaData.mimetype || 'application/octet-stream'
    const ext = mimeType.split('/')[1]?.split(';')[0]?.split('+')[0] || 'bin'
    const folder = mediaData.messageType.replace('Message', '')
    const path = `${folder}/${evolutionId}.${ext}`
    const buffer = Buffer.from(result.base64, 'base64')

    const { error: uploadError } = await supabase.storage
      .from('whatsapp-media')
      .upload(path, buffer, { contentType: mimeType, upsert: true })

    if (uploadError) {
      console.error('[webhook] erro upload storage:', uploadError.message)
      return
    }

    const { data: { publicUrl } } = supabase.storage
      .from('whatsapp-media')
      .getPublicUrl(path)

    await supabase.from('whatsapp_mensagens')
      .update({ media_url: publicUrl })
      .eq('evolution_id', evolutionId)

    console.log('[webhook] mídia armazenada:', path, '→', publicUrl.slice(0, 60))
  } catch (err) {
    console.error('[webhook] erro ao baixar mídia:', evolutionId, '|', err.message)
  }
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

// Lógica pura do webhook do WhatsApp, sem depender de req/res — permite ser
// chamada tanto pela rota direta (/api/whatsapp/webhook) quanto internamente
// pelo webhook do SDR (/api/sdr/webhook), que recebe o mesmo payload da Evolution.
export async function processWhatsappEvent(payload) {
  try {
    // Volume de "messages.update" pode chegar a dezenas por segundo (um ACK de
    // entrega/leitura por destinatário, por mensagem) — logar cada evento aqui
    // (e formatar Object.keys(...) com console.log) sobrecarregava o event loop
    // sob picos de tráfego e deixava o servidor inteiro lento (até o /health).
    // Sem log de evento aqui; cada ramo abaixo loga só quando há algo relevante.

    // ── Status de entrega/leitura ─────────────────────────────────────────
    if (payload.event === 'messages.update') {
      const updates = Array.isArray(payload.data) ? payload.data : [payload.data]
      for (const upd of updates) {
        const msgId = upd.keyId ?? upd.key?.id
        const novoStatus = mapStatus(upd.status ?? upd.update?.status)
        if (msgId && novoStatus) {
          await supabase
            .from('whatsapp_mensagens')
            .update({ status: novoStatus })
            .eq('evolution_id', msgId)
          console.log('[webhook] status atualizado:', msgId.slice(0, 12), '→', novoStatus)
        }
      }
      return
    }

    if (payload.event !== 'messages.upsert') return

    const msg = Array.isArray(payload.data) ? payload.data[0] : payload.data
    if (!msg) return

    const fromMe = msg.key?.fromMe === true
    const remoteJid = msg.key?.remoteJid ?? ''
    const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '')

    // Mensagens efêmeras ("apagar após visualização") e de visualização única embrulham
    // o conteúdo real um nível mais profundo — sem isso, a mídia/texto real nunca é
    // encontrado e a mensagem cai no fallback genérico "[mídia]".
    const conteudo = msg.message?.ephemeralMessage?.message
      || msg.message?.viewOnceMessage?.message
      || msg.message
      || {}

    const midia = detectarMidia(msg, conteudo)
    const texto =
      conteudo.conversation ??
      conteudo.extendedTextMessage?.text ??
      midia?.texto ??
      '[mídia]'
    const mediaTipo = midia?.tipo ?? null
    const mediaData = midia?.mediaData ?? null

    const direcao = fromMe ? 'saida' : 'entrada'
    const status = fromMe ? 'enviado' : 'recebido'
    console.log('[webhook]', direcao, '| tel:', telefone, '| tipo:', mediaTipo ?? 'texto', '|', texto.slice(0, 50))

    const semPrefixo = telefone.replace(/^55/, '')
    // candidatosTelefone cobre as mesmas variações de 9º dígito de antes, mais as formas
    // com prefixo "55" — sem isso, um lead criado manualmente com o telefone salvo nesse
    // formato nunca era encontrado e o webhook criava um segundo lead duplicado.
    const candidatos = candidatosTelefone(telefone)

    const { data: leads } = await supabase
      .from('leads')
      .select('id, telefone')
      .in('telefone', candidatos)
      .limit(1)

    let lead = leads?.[0] ?? null

    if (!lead && !fromMe) {
      const vendedor = await proximoVendedor()
      const origem = detectarAnuncio(msg) ?? detectarCampanha(texto)
      const campanha_origem = detectarCampanhaOrigem(msg, texto)
      const { data: novoLead, error } = await supabase
        .from('leads')
        .insert({
          nome: `Lead WhatsApp ${semPrefixo}`,
          telefone: semPrefixo,
          etapa: 'novo',
          origem,
          campanha_origem,
          responsavel_id: vendedor?.id ?? null,
        })
        .select('id, nome, responsavel_id')
        .single()

      if (!error && novoLead) {
        lead = novoLead
        console.log('[webhook] novo lead criado:', novoLead.nome, '→ vendedor:', vendedor?.nome, '| origem:', origem, '| campanha:', campanha_origem)
      } else {
        console.error('[webhook] erro ao criar lead:', error?.message)
      }
    }

    const evolutionId = msg.key?.id ?? null

    await supabase.from('whatsapp_mensagens').insert({
      lead_id: lead?.id ?? null,
      mensagem: texto,
      direcao,
      telefone,
      status,
      evolution_id: evolutionId,
      media_tipo: mediaTipo,
      media_data: mediaData,
    })

    // Fire-and-forget: baixa mídia e salva no Supabase Storage
    if (mediaTipo && evolutionId && !fromMe) {
      baixarEArmazenarMidia(evolutionId, mediaData).catch(() => {})
    }

    // Resposta do cliente a um follow-up automático de reativação — verifica em
    // background, não atrasa o resto do processamento desse webhook.
    if (lead && !fromMe) {
      detectarRespostaReativacao(lead.id, texto).catch((err) =>
        console.error('[reativacao] erro ao processar resposta:', err.message)
      )
    }
  } catch (err) {
    console.error('[webhook] erro:', err.message, '| body:', JSON.stringify(payload).slice(0, 200))
  }
}

export default async function handleWebhook(req, res) {
  await processWhatsappEvent(req.body)
  res.sendStatus(200)
}
