import { candidatosTelefone } from './telefone.js'

const tables = new Set(['sdr_conversas','site_campaign_conversas'])
const bounded = q => q.abortSignal(AbortSignal.timeout(8000))
export const HUMAN_TRANSFER_REPLY = 'Vou encaminhar sua dúvida para um atendente da nossa equipe, que continuará o atendimento por aqui.'

export async function humanOwnsSdr({db,table,phone}) {
 if(!tables.has(table)) throw Error('SDR_INVALID_TABLE')
 const phones=candidatosTelefone(phone)
 const [leads,conversations]=await Promise.all([
  bounded(db.from('leads').select('id').in('telefone',phones).or('atendimento_humano.eq.true,whatsapp_opt_out.eq.true,ativo.eq.false').limit(1)),
  bounded(db.from(table).select('telefone').in('telefone',phones).eq('status_atendimento','vendedor_assumiu').limit(1)),
 ])
 if(leads.error||conversations.error||!Array.isArray(leads.data)||!Array.isArray(conversations.data))throw Error('SDR_OWNERSHIP_UNCONFIRMED')
 return !!(leads.data?.length||conversations.data?.length)
}

export async function saveLaraTurn({db,table,phone,payload,exists}) {
 if(!tables.has(table))throw Error('SDR_INVALID_TABLE')
 // Never overwrite a takeover during model generation. Concurrent first turns
 // fail on the unique phone key instead of replacing the human's conversation.
 const q=exists
  ? db.from(table).update(payload).eq('telefone',phone).or('status_atendimento.is.null,status_atendimento.neq.vendedor_assumiu')
  : db.from(table).insert({...payload,telefone:phone})
 const result=await bounded(q.select('telefone'))
 if(result.error||!Array.isArray(result.data)||!result.data.length)throw Error('SDR_TURN_NOT_RESERVED')
}

export async function transferSdrToHuman({db,table,phone}) {
 if(await humanOwnsSdr({db,table,phone}))return false
 const leads=await bounded(db.from('leads').update({atendimento_humano:true,handoff_alerta_nivel:0}).in('telefone',candidatosTelefone(phone)).or('atendimento_humano.is.null,atendimento_humano.eq.false').select('id'))
 if(leads.error||!Array.isArray(leads.data)||!leads.data.length)throw Error('SDR_HANDOFF_LEAD_UNCONFIRMED')
 const conversation=await bounded(db.from(table).upsert({telefone:phone,status_atendimento:'vendedor_assumiu',ultimo_contato:new Date().toISOString()},{onConflict:'telefone'}))
 if(conversation.error)throw Error('SDR_HANDOFF_CONVERSATION_UNCONFIRMED')
 return true
}

export async function releaseSdrToLara({db,phone}) {
 for(const table of tables){
  const result=await bounded(db.from(table).update({status_atendimento:'ia_atendendo'}).in('telefone',candidatosTelefone(phone)).eq('status_atendimento','vendedor_assumiu'))
  if(result.error)throw Error('SDR_RELEASE_UNCONFIRMED')
 }
}

export async function releaseLeadToLara({db,leadId}) {
 const lead=await bounded(db.from('leads').select('telefone').eq('id',leadId).maybeSingle())
 if(lead.error)throw Object.assign(Error('SDR_RELEASE_LEAD_UNCONFIRMED'),{status:503})
 if(!lead.data?.telefone)throw Object.assign(Error('Lead não encontrado'),{status:404})
 // A partial conversation release still leaves the global human flag set.
 await releaseSdrToLara({db,phone:lead.data.telefone})
 const released=await bounded(db.from('leads').update({atendimento_humano:false,handoff_alerta_nivel:0,updated_at:new Date().toISOString()}).eq('id',leadId).select().single())
 if(released.error||!released.data)throw Error('SDR_RELEASE_LEAD_UNCONFIRMED')
 return released.data
}

export async function observeSdrHumanOutbound({db,table,instance,message,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
 if(!tables.has(table))throw Error('SDR_INVALID_TABLE')
 const key=message?.key
 if(key?.fromMe!==true)return false
 const jid=key.remoteJid?.endsWith('@lid')?key.remoteJidAlt:key.remoteJid
 if(typeof jid!=='string'||!/^\d{10,15}@s\.whatsapp\.net$/.test(jid)||typeof key.id!=='string'||!key.id||key.id.length>256)return false
 let known
 // The provider's echo can arrive just before the API response is recorded.
 // Recheck briefly before treating an unknown outbound as a human reply.
 for(let attempt=0;attempt<3;attempt++){
  if(attempt>0)await wait(200)
  known=await bounded(db.from('whatsapp_mensagens').select('evolution_id').eq('evolution_id',key.id).eq('instance_name',instance).eq('direcao','saida').limit(1).maybeSingle())
  if(known.error)throw Error('SDR_OUTBOUND_ORIGIN_UNCONFIRMED')
  if(known.data?.evolution_id===key.id)return false
 }
 // A replay of an already persisted API send must never pause Lara.
 if(known.data?.evolution_id===key.id)return false
 return claimSdrForHuman({db,table,phone:jid.split('@')[0]})
}

export async function claimSdrForHuman({db,table,phone,leadId}) {
 if(!tables.has(table))throw Error('SDR_INVALID_TABLE')
 const phones=candidatosTelefone(phone)
 const existing=await bounded(db.from(table).select('telefone').in('telefone',phones).order('ultimo_contato',{ascending:false}).limit(1).maybeSingle())
 if(existing.error)throw Error('SDR_OUTBOUND_OWNER_UNCONFIRMED')
 const conversation=await bounded(db.from(table).upsert({telefone:existing.data?.telefone||phone,status_atendimento:'vendedor_assumiu',ultimo_contato:new Date().toISOString()},{onConflict:'telefone'}).select('telefone'))
 if(conversation.error||!Array.isArray(conversation.data)||!conversation.data.length)throw Error('SDR_OUTBOUND_PAUSE_UNCONFIRMED')
 const leads=await bounded(db.from('leads').update({atendimento_humano:true,handoff_alerta_nivel:0}).in('telefone',phones))
 if(leads.error)throw Error('SDR_OUTBOUND_LEAD_UNCONFIRMED')
 // Preserve the explicit CRM lead selection when its stored phone uses another format.
 if(leadId){
  const selected=await bounded(db.from('leads').update({atendimento_humano:true,handoff_alerta_nivel:0}).eq('id',leadId).select('id'))
  if(selected.error||!Array.isArray(selected.data)||!selected.data.length)throw Error('SDR_SELECTED_LEAD_UNCONFIRMED')
 }
 return true
}
