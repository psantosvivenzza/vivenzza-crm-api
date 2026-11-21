const validId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/.test(value)

export function prepareHistoryMessage(item, instance, leadId) {
  if (!validId(item?.messageId) || typeof item.fromMe !== 'boolean' || !/^\d{10,15}@s\.whatsapp\.net$/.test(item.chatJid || '')) return null
  const originalTime = Number(item.messageTimestamp)
  const time = originalTime > 100000000000 ? originalTime / 1000 : originalTime
  if (!Number.isSafeInteger(originalTime) || time <= 0 || time * 1000 > Date.now() + 300000) return null
  const type = ['audio','image','video','document','sticker'].includes(item.messageType) ? item.messageType : null
  const content = item.deleted ? '[Mensagem apagada no WhatsApp]' : String(item.content || (type ? `[${type}]` : '[Mensagem sem texto]'))
  if (content.length > 100000) return null
  return { lead_id: leadId, instance_name: instance, evolution_id: item.messageId,
    telefone: item.chatJid.split('@')[0], direcao: item.fromMe ? 'saida' : 'entrada',
    mensagem: content, status: item.fromMe ? 'enviado' : 'recebido',
    created_at: new Date(time * 1000).toISOString(), media_tipo: type,
    media_data: type ? { historyImported: true, messageType: `${type}Message`, remoteJid: item.chatJid, fromMe: item.fromMe } : null }
}

export function createHistorySync({ db, instance, fetchPage, resolveLead, linkLeads = true }) {
  let state = { running: false, completed: false, scanned: 0, inserted: 0, existing: 0, skipped: 0, pages: 0 }
  let task = null
  async function run(since, until, createMissing) {
    let cursor = null
    const cursors = new Set(), leads = new Map()
    try {
      for (let page = 0; page < 10000; page++) {
        const result = await fetchPage(cursor, { since, until })
        if (!result || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean') throw Error('HISTORY_INVALID_PAGE')
        const ids = result.items.map(item => item?.messageId).filter(validId)
        const existing = new Map()
        for (let offset=0;offset<ids.length;offset+=20) {
          let known
          try { known=await db.from('whatsapp_mensagens').select('evolution_id,instance_name').in('evolution_id',ids.slice(offset,offset+20)).abortSignal(AbortSignal.timeout(15000)) }
          catch { throw Error('HISTORY_LOOKUP_FAILED') }
          if (known.error || !Array.isArray(known.data)) throw Error('HISTORY_LOOKUP_FAILED')
          for (const row of known.data) existing.set(row.evolution_id,row.instance_name)
        }
        const rows = []
        for (const item of result.items) {
          state.scanned++
          if (existing.has(item?.messageId)) {
            if (existing.get(item.messageId) && existing.get(item.messageId)!==instance) { state.skipped++; state.collisions++; continue }
            state.existing++; continue
          }
          const prepared = prepareHistoryMessage(item, instance, null)
          if (!prepared) { state.skipped++; continue }
          if (prepared.created_at > until) { state.skipped++; continue }
          if (since && Date.parse(prepared.created_at) < Date.parse(since)) { state.skipped++; continue }
          const phone = prepared.telefone
          let leadId = null
          if (linkLeads) {
            if (!leads.has(phone)) {
              try { leads.set(phone, await resolveLead(phone, item, { allowCreate: createMissing })) }
              catch { throw Error('HISTORY_LEAD_FAILED') }
            }
            leadId = leads.get(phone)
            if (!leadId) { if (!createMissing) { state.skipped++; continue }; throw Error('HISTORY_LEAD_FAILED') }
          }
          rows.push({ ...prepared, lead_id: leadId })
        }
        if (rows.length) {
          let saved
          try { saved = await db.from('whatsapp_mensagens').upsert(rows, { onConflict: 'evolution_id', ignoreDuplicates: true }).select('id').abortSignal(AbortSignal.timeout(20000)) }
          catch { throw Error('HISTORY_SAVE_FAILED') }
          if (saved.error || !Array.isArray(saved.data)) throw Error('HISTORY_SAVE_FAILED')
          state.inserted += saved.data.length
        }
        state.pages++
        if (!result.hasMore) { state.completed = true; break }
        if (!Number.isSafeInteger(result.nextBefore) || !Number.isSafeInteger(result.nextBeforeId)) throw Error('HISTORY_INVALID_CURSOR')
        cursor = { before: result.nextBefore, beforeId: result.nextBeforeId }
        const key = JSON.stringify(cursor)
        if (cursors.has(key)) throw Error('HISTORY_CURSOR_STALLED')
        cursors.add(key)
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (!state.completed) throw Error('HISTORY_PAGE_LIMIT')
    } catch (error) {
      state.error = /^HISTORY_[A-Z_0-9]{1,64}$/.test(error.message) ? error.message : 'HISTORY_PROVIDER_UNAVAILABLE'
      console.error('[whatsapp-history]', { code: state.error })
    } finally { state.running = false; state.finishedAt = new Date().toISOString(); task = null }
  }
  return {
    status: () => ({ ...state }),
    start({ since = null, until = new Date(Date.now()-10*60000).toISOString(), createMissing = false } = {}) {
      if (state.running) return { ...state }
      if (since !== null && (typeof since !== 'string' || !since || !Number.isFinite(Date.parse(since)))) throw Error('HISTORY_INVALID_WINDOW')
      if (typeof until !== 'string' || !Number.isFinite(Date.parse(until))) throw Error('HISTORY_INVALID_WINDOW')
      since = since === null ? null : new Date(since).toISOString()
      until = new Date(until).toISOString()
      if (since && since > until) throw Error('HISTORY_INVALID_WINDOW')
      if (typeof createMissing !== 'boolean' || (since && createMissing)) throw Error('HISTORY_INVALID_MODE')
      state = { running: true, completed: false, mode: since ? 'recent' : createMissing ? 'full' : 'known', scanned: 0, inserted: 0, existing: 0, skipped: 0, collisions: 0, pages: 0, startedAt: new Date().toISOString() }
      task = run(since, until, createMissing)
      return { ...state }
    },
    wait: () => task,
  }
}
