import { supabase } from '../lib/supabase.js'

async function proximoVendedor() {
  // Busca vendedores ativos em ordem alfabética (Ana → Rafaela → Tatiane)
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
  // Próximo na fila; se não encontrou (ou é o último), volta para o índice 0
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

    if (payload.event !== 'messages.upsert') return res.sendStatus(200)

    // Evolution API v2: payload.data é o objeto da mensagem diretamente
    const msg = Array.isArray(payload.data) ? payload.data[0] : payload.data
    if (!msg || msg.key?.fromMe) return res.sendStatus(200)

    const remoteJid = msg.key?.remoteJid ?? ''
    const telefone = remoteJid.replace('@s.whatsapp.net', '').replace('@lid', '')
    const texto =
      msg.message?.conversation ??
      msg.message?.extendedTextMessage?.text ??
      '[mídia]'

    console.log('[webhook] mensagem de:', telefone, '|', texto.slice(0, 50))

    // Busca lead pelo telefone — cobre formato antigo (8 dig) e novo (9 dig)
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

    // Auto-criação de lead para números desconhecidos
    if (!lead) {
      const vendedor = await proximoVendedor()
      const { data: novoLead, error } = await supabase
        .from('leads')
        .insert({
          nome: `Lead WhatsApp ${semPrefixo}`,
          telefone: semPrefixo,
          etapa: 'novo',
          origem: 'whatsapp',
          responsavel_id: vendedor?.id ?? null,
        })
        .select('id, nome, responsavel_id')
        .single()

      if (!error && novoLead) {
        lead = novoLead
        console.log('[webhook] novo lead criado:', novoLead.nome, '→ vendedor:', vendedor?.nome)
      } else {
        console.error('[webhook] erro ao criar lead:', error?.message)
      }
    }

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
