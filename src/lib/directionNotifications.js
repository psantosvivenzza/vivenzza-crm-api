import { readFzapConfig } from './fzapConnections.js'
import { createWhatsappProviderClient, whatsappTransportFor } from './whatsappProviderClient.js'
import { createHmac } from 'node:crypto'

// Separate sender and recipient. Never silently fall back to sales or finance.
export function createDirectionNotifier({ env = process.env, transportFor = whatsappTransportFor, clientFactory = createWhatsappProviderClient, journal } = {}) {
  async function resolve(recipient) {
    if (typeof recipient !== 'string' || !/^55\d{10,11}$/.test(recipient)) throw new Error('NOTIFICATION_RECIPIENT_NOT_CONFIGURED')
    const config = readFzapConfig(env)
    const connection = config?.connections.find(c => c.id === 'direcao-notificacoes' && c.instanceName === 'vivenzza-notificacoes-direcao' && c.finalidade === 'notificacoes')
    if (!connection || await transportFor(connection.instanceName, { env }) !== 'fzap') throw new Error('NOTIFICATION_CONNECTION_NOT_READY')
    const client = clientFactory({}, { env })
    const status = await client.get('/instance/connectionState/' + encodeURIComponent(connection.instanceName))
    if (status?.data?.instance?.state !== 'open') throw new Error('NOTIFICATION_CONNECTION_NOT_READY')
    return { connection, client }
  }
  async function notify(text, { recipient = env.DIRECTION_REPORT_NUMBER, key } = {}) {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('NOTIFICATION_CONTENT_INVALID')
    const { connection, client } = await resolve(recipient)
    let deliveryKey
    if (key != null) {
      if (typeof key !== 'string' || !/^[A-Za-z0-9:_-]{1,240}$/.test(key) || !journal) throw Error('NOTIFICATION_JOURNAL_REQUIRED')
      if (!/^[A-Za-z0-9_-]{32,256}$/.test(env.FZAP_WEBHOOK_SECRET || '')) throw Error('NOTIFICATION_JOURNAL_SECRET_REQUIRED')
      deliveryKey=key+':'+createHmac('sha256',env.FZAP_WEBHOOK_SECRET).update(recipient).digest('hex')
      const reservation=await journal.claim(deliveryKey)
      if (!reservation.created) {
        if (reservation.status==='sent' && reservation.providerMessageId) return {status:'sent',providerMessageId:reservation.providerMessageId}
        throw Error('NOTIFICATION_PREVIOUS_UNCERTAIN')
      }
    }
    let result
    try {
      result=await client.post('/message/sendText/' + encodeURIComponent(connection.instanceName), { number: recipient, text })
      if (!result?.data?.key?.id) throw Error('NOTIFICATION_OUTCOME_UNCERTAIN')
    } catch {
      if (deliveryKey) await journal.finish(deliveryKey,'uncertain',null)
      throw Error('NOTIFICATION_OUTCOME_UNCERTAIN')
    }
    if (deliveryKey) await journal.finish(deliveryKey,'sent',result.data.key.id)
    return { status: 'sent', providerMessageId: result.data.key.id }
  }
  notify.ready = async () => { try { await resolve(env.DIRECTION_REPORT_NUMBER); return true } catch { return false } }
  return notify
}
const database = async () => (await import('./supabase-admin.server.js')).supabase
export const enviarNotificacaoDirecao = createDirectionNotifier({journal:{
 async claim(key) {
  const db=await database()
  const result=await db.from('direction_notification_deliveries').insert({key}).select('status,provider_message_id').single().abortSignal(AbortSignal.timeout(10000))
  if (!result.error) return {created:true}
  if (result.error.code!=='23505') throw Error('NOTIFICATION_JOURNAL_UNAVAILABLE')
  const old=await db.from('direction_notification_deliveries').select('status,provider_message_id').eq('key',key).single().abortSignal(AbortSignal.timeout(10000))
  if (old.error || !old.data) throw Error('NOTIFICATION_JOURNAL_UNAVAILABLE')
  return {created:false,status:old.data.status,providerMessageId:old.data.provider_message_id}
 },
 async finish(key,status,id) {
  const db=await database()
  const r=await db.from('direction_notification_deliveries').update({status,provider_message_id:id,updated_at:new Date().toISOString()}).eq('key',key).eq('status','reserved').abortSignal(AbortSignal.timeout(10000))
  if (r.error) throw Error('NOTIFICATION_JOURNAL_UNAVAILABLE')
 }
}})
