import { supabase } from './supabase-admin.server.js'
import { readFzapConfig, fzapConnectionTransport } from './fzapConnections.js'
import { whatsappTransportFor } from './whatsappProviderClient.js'
import { candidatosTelefone } from './telefone.js'
import { criarOuObterLeadWhatsapp } from './distribuicao.js'
import { createHistorySync } from './whatsappHistory.js'

function workerFor(source) {
 const instance=source.instanceName
 return createHistorySync({
  db: supabase, instance, linkLeads:source.finalidade==='comercial',
  async fetchPage(cursor, { since, until }) {
    const config = readFzapConfig()
    const connection = config?.connections.find(item => item.id===source.id && item.instanceName === instance && item.finalidade === source.finalidade)
    if (!connection) throw Error('HISTORY_OWNERSHIP_UNCONFIRMED')
    try {
      if (await whatsappTransportFor(instance) !== 'fzap') throw Error('HISTORY_OWNERSHIP_UNCONFIRMED')
    } catch (error) {
      if (/^HISTORY_/.test(error.message)) throw error
      throw Error('HISTORY_SESSION_' + (/^FZAP_[A-Z_]+$/.test(error.code || '') ? error.code : 'UNAVAILABLE'))
    }
    const query = new URLSearchParams({ scope: 'contacts', limit: '100', date_to:until, ...cursor })
    if (since) query.set('date_from', since)
    let response
    try {
      response = await fzapConnectionTransport({baseURL:config.baseURL,path:'/chat/messages?'+query,method:'GET',token:connection.token,signal:AbortSignal.timeout(20000)})
    } catch (error) {
      const reason = /^(HTTP_[0-9]{3}|RESPONSE_LIMIT)$/.test(error.historyReason || '') ? error.historyReason
        : ['ENOTFOUND','ECONNREFUSED','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.cause?.code) ? error.cause.code : 'UNAVAILABLE'
      throw Error('HISTORY_FETCH_' + reason)
    }
    if (response.success !== true) throw Error('HISTORY_PROVIDER_UNAVAILABLE')
    return response.data
  },
  async resolveLead(phone, item, { allowCreate }) {
    const candidates = candidatosTelefone(phone)
    const found = await supabase.from('leads').select('id').in('telefone', candidates).order('criado_em',{ascending:true}).limit(1).abortSignal(AbortSignal.timeout(15000))
    if (found.error) throw Error('HISTORY_LEAD_LOOKUP_FAILED')
    if (found.data?.[0]) return found.data[0].id
    if (!allowCreate) return null
    const name=!item.fromMe && typeof item.senderName==='string' ? item.senderName.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,100) : ''
    const lead = await criarOuObterLeadWhatsapp({ candidatos:candidates,telefone:phone.replace(/^55/,''),
      nome:name || 'Contato WhatsApp',origem:'whatsapp',campanhaOrigem:'historico_whatsapp',ctwaClid:null })
    return lead?.id ?? null
  },
 })
}

let workers=[],task=null,startedAt=null,finishedAt=null,mode=null,fatalError=null
export const whatsappHistory = {
 status() {
  const statuses=workers.map(({source,worker})=>({instance:source.instanceName,...worker.status()}))
  return {running:!!task,completed:!!finishedAt&&statuses.every(state=>state.completed),mode,startedAt,finishedAt,
   ...Object.fromEntries(['scanned','inserted','existing','skipped','collisions','pages'].map(key=>[key,statuses.reduce((total,state)=>total+(state[key]||0),0)])),
   error:fatalError||(statuses.some(state=>state.error)?'HISTORY_PARTIAL':null),instances:statuses}
 },
 start({since=null,createMissing=false}={}) {
  if(task)return this.status()
  if(since!==null&&(typeof since!=='string'||!since||!Number.isFinite(Date.parse(since))))throw Error('HISTORY_INVALID_WINDOW')
  since=since===null?null:new Date(since).toISOString()
  if(typeof createMissing!=='boolean'||(since&&createMissing))throw Error('HISTORY_INVALID_MODE')
  const primary=process.env.EVOLUTION_INSTANCE||'vivenzza'
  const site=process.env.SDR_SITE_INSTANCE
  const config=readFzapConfig()
  const sources=(config?.connections||[]).filter(source=>(source.finalidade==='financeiro'&&(since||createMissing))||(source.finalidade==='comercial'&&[primary,site].includes(source.instanceName)))
  if(!sources.length)throw Error('HISTORY_CONFIG_UNAVAILABLE')
  workers=sources.map(source=>({source,worker:workerFor(source)}))
  startedAt=new Date().toISOString();finishedAt=null;fatalError=null;mode=since?'recent':createMissing?'full':'known'
  const until=new Date(Date.now()-10*60000).toISOString()
  task=Promise.resolve().then(async()=>{
   for(const {worker} of workers){worker.start({since,until,createMissing});await worker.wait()}
  }).catch(()=>{fatalError='HISTORY_RUNTIME_FAILED'}).finally(()=>{finishedAt=new Date().toISOString();task=null})
  return this.status()
 },
}
