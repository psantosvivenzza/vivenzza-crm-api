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
    // Cobre formato antigo (8 dígitos) e novo (9 dígitos) de números brasileiros
    const semPrefixo = telefone.replace(/^55/, '')
    // Se 10 dígitos após 55 (DDD + 8 = formato antigo), tenta com 9 inserido após DDD
    const com9 = semPrefixo.length === 10 ? semPrefixo.slice(0, 2) + '9' + semPrefixo.slice(2) : null
    // Se 11 dígitos após 55 (DDD + 9 = formato novo), tenta sem o 9
    const sem9 = semPrefixo.length === 11 ? semPrefixo.slice(0, 2) + semPrefixo.slice(3) : null

    const candidatos = [telefone, semPrefixo, com9, sem9].filter(Boolean)

    const { data: leads } = await supabase
      .from('leads')
      .select('id, telefone')
      .in('telefone', candidatos)
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
