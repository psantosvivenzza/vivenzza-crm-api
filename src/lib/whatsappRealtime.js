export function createWhatsappRealtime(db) {
  const listeners = new Set()
  let channel = null, connected = false, pending = null, generation = 0
  const broadcast = type => { for (const listener of listeners) listener(type, connected) }
  function changed() {
    if (pending) return
    pending = setTimeout(() => { pending = null; broadcast('change') }, 750)
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      if (!channel) {
        const current = ++generation
        channel = db.channel('crm-whatsapp-invalidation')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_mensagens' }, changed)
          .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, changed)
          .subscribe(status => { if (current === generation) { connected = status === 'SUBSCRIBED'; broadcast('ready') } })
      }
      listener('ready', connected)
      return () => {
        listeners.delete(listener)
        if (!listeners.size && channel) {
          const old = channel; channel = null; connected = false; generation++
          if (pending) clearTimeout(pending)
          pending = null
          db.removeChannel(old).catch(() => {})
        }
      }
    },
  }
}

export function createWhatsappEventStream(hub) {
  const counts = new Map()
  return function stream(req, res) {
    if (!['admin', 'financeiro', 'vendedor'].includes(req.user?.role)) return res.sendStatus(403)
    const key = req.user.id
    if ((counts.get(key) ?? 0) >= 5) return res.status(429).json({ erro: 'Limite de conexões de atualização atingido.' })
    counts.set(key, (counts.get(key) ?? 0) + 1)
    let unsubscribe=()=>{},heartbeat,expiry,closed=false
    const cleanup=()=>{
      if(closed)return
      closed=true;unsubscribe();clearInterval(heartbeat);clearTimeout(expiry)
      const remaining=(counts.get(key)??1)-1
      if(remaining)counts.set(key,remaining);else counts.delete(key)
    }
    res.on('close',cleanup)
    try {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-store', 'X-Accel-Buffering': 'no' })
    res.flushHeaders()
    req.setTimeout(0); res.setTimeout(0)
    // Stream invalidations only. Message data still uses the existing ACL.
    unsubscribe = hub.subscribe((type, realtime) => {
      if (!res.destroyed && !res.writableEnded && !res.write(`event: ${type}\ndata: ${JSON.stringify({ realtime })}\n\n`)) res.end()
    })
    if(closed){unsubscribe();return}
    heartbeat = setInterval(() => { if (!res.writableEnded && !res.write(': heartbeat\n\n')) res.end() }, 15000)
    expiry = setTimeout(() => res.end(), 55000)
    } catch { cleanup();res.end() }
  }
}
