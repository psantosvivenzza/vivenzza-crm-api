import { supabase } from '../lib/supabase.js'

export default async function handleWebhook(req, res) {
  try {
    const payload = req.body
    console.log('[webhook] event:', payload.event, '| data keys:', Object.keys(payload.data || {}))

    if (payload.event !== 'messages.upsert') return res.sendStatus(200)

    // Evolution API v2: payload.data é o objeto da mensagem diretamente
    // Em alguns casos pode vir como array; cobre os dois formatos
    const msg = Array.isArray(payload.data) ? payload.data[0] : payload.data

    if (!msg || msg.key?.fromMe) return res.sendStatus(200)

    const remoteJid = msg.key?.remoteJid ?? ''
    const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '')
    const texto =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      '[mídia]'

    console.log('[webhook] mensagem de:', telefone, '|', texto.slice(0, 50))

    // Busca lead pelo telefone com e sem prefixo 55
    const semPrefixo = telefone.replace(/^55/, '')
    const { data: leads } = await supabase
      .from('leads')
      .select('id, telefone')
      .in('telefone', [telefone, semPrefixo])
      .limit(1)

    const lead = leads?.[0] ?? null

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
    console.error('[webhook] erro:', err.message, '| body:', JSON.stringify(req.body).slice(0, 200))
    res.sendStatus(200)
  }
}
