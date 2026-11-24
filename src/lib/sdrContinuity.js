import { candidatosTelefone } from './telefone.js'

// FIFO per conversation in this Node worker. Re-read history inside the task,
// never before joining the queue; another conversation/channel stays independent.
export function createSdrTurnQueue({minIntervalMs=0, now=()=>Date.now(), wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const tails = new Map()
  const started = new Map()
  return function run(key, task) {
    const previous = tails.get(key) || Promise.resolve()
    const result = previous.catch(() => {}).then(async()=>{
      const delay = Math.max(0, (started.get(key) ?? -Infinity) + minIntervalMs - now())
      if (delay) await wait(delay)
      started.set(key, now())
      return task()
    })
    const tail = result.catch(() => {})
    tails.set(key, tail)
    tail.finally(() => { if (tails.get(key) === tail) {tails.delete(key);started.delete(key)} })
    return result
  }
}
export function sdrTurnKey(instance, table, message) {
  const key = message?.key
  const raw = key?.remoteJid?.endsWith('@lid') ? key.remoteJidAlt : key?.remoteJid
  const jid = typeof raw === 'string' ? raw.replace(/:\d+(?=@s\.whatsapp\.net$)/,'') : raw
  if (typeof jid !== 'string' || !/^\d{10,15}@s\.whatsapp\.net$/.test(jid)) return null
  const canonical = candidatosTelefone(jid.split('@')[0]).sort((a,b) => a.length-b.length || a.localeCompare(b))[0]
  return canonical ? `${table}:${instance}:${canonical}` : null
}
export function prepareSdrTurn(history, inbound, type) {
  const prior = Array.isArray(history) ? history.map(h => ({...h})) : []
  const continuing = prior.some(h => h.role === 'assistant' && typeof h.content === 'string' && h.content.trim())
  const recent = [...prior, {role:'user', content:inbound, tipo:type, timestamp:new Date().toISOString()}].slice(-20)
  const modelHistory = recent.filter(h=>['user','assistant'].includes(h.role)&&typeof h.content==='string'&&h.content.trim())
  const messages = []
  // Keep the previous question, including the landing's assistant-only opening.
  // Fixed context line satisfies the API's initial-user format without saving a
  // fabricated customer message in the CRM.
  if (modelHistory[0]?.role === 'assistant') messages.push({role:'user',content:'Continue o atendimento comercial já iniciado, conforme o histórico abaixo.'})
  for (const h of modelHistory) {
    if (messages.at(-1)?.role === h.role) messages.at(-1).content += '\n' + h.content
    else messages.push({role:h.role,content:h.content})
  }
  return {recent, messages, continuing}
}
export function sdrContinuityInstructions(continuing) {
  return continuing ? '\nCONTINUIDADE OBRIGATÓRIA: Você já iniciou este atendimento. Não se apresente novamente, não diga "aqui é a Lara" e não repita a saudação inicial. O estado NOVO não autoriza reiniciar uma conversa que já tem resposta sua no histórico. Reconheça a resposta mais recente e prossiga de onde parou, com uma única pergunta ainda não respondida. Se o perfil já foi informado, não volte a perguntar salão/uso próprio/distribuição. Use as informações já recebidas e avance à próxima informação de qualificação e ao próximo passo comercial.\n' : ''
}

