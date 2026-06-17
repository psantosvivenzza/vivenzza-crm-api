import { supabase } from '../lib/supabase.js'

export default async function handleWebhook(req, res) {
  try {
    const payload = req.body

    if (payload.event !== 'messages.upsert') return res.sendStatus(200)

    const msg = payload.data?.messages?.[0]
    if (!msg || msg.key?.fromMe) return res.sendStatus(200)

    const telefone = msg.key?.remoteJid?.replace('@s.whatsapp.net', '') ?? ''
    const texto =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      '[mídia]'

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
    console.error('[webhook]', err.message)
    res.sendStatus(200)
  }
}
