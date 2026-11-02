import Anthropic from '@anthropic-ai/sdk'
import {supabase as db} from './supabase-admin.server.js'
import {createWhatsappProviderClient,whatsappTransportFor} from './whatsappProviderClient.js'
import {verificarFrescorSync} from './collection/financialSyncGuard.js'
import {estaEmDoNotContact} from './collection/doNotContactGuard.js'
import {dentroDaJanela} from './collection/collectionContactPolicy.js'
import {telefonesEquivalentes} from './telefone.js'
import {isStopRequest} from './siteCampaignPolicy.js'
import {CLASSIFY_SYSTEM_PROMPT,validarClassificacao} from './collection/ai/intentClassifier.js'
import {createFinancialInboundProcessor} from './financialAiPolicy.js'
const checked=async q=>{const r=await q.abortSignal(AbortSignal.timeout(10000));if(r.error)throw Error('FINANCIAL_AI_STORAGE');return r.data}
const client=createWhatsappProviderClient({})
const config=()=>checked(db.from('automacoes_config').select('financial_ai_enabled,financial_ai_enabled_at,cobranca_whatsapp_ativa').eq('id',1).single())
const contact=async input=>{
 await checked(db.from('financial_ai_contacts').upsert({phone:input.phone,instance_name:input.instance},{onConflict:'phone',ignoreDuplicates:true}))
 let row=await checked(db.from('financial_ai_contacts').select('id,human,reason,updated_at,instance_name').eq('phone',input.phone).single())
 if(input.id && row.instance_name!==input.instance){
  const latest=await checked(db.from('whatsapp_mensagens').select('id').eq('telefone',input.phone).eq('direcao','entrada').order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).maybeSingle())
  if(latest?.id===input.id)row=await checked(db.from('financial_ai_contacts').update({instance_name:input.instance,reason:row.reason==='operator_released'?'channel_changed':row.reason,updated_at:new Date().toISOString()}).eq('id',row.id).eq('updated_at',row.updated_at).select('id,human,reason,updated_at,instance_name').single())
 }
 return row
}
export async function markFinancialHuman(phone,reason='operator') {
 await checked(db.from('financial_ai_contacts').update({human:true,reason,updated_at:new Date().toISOString()}).eq('phone',phone).select('id').single())
}
const guard=async input=>{
 const c=await config()
 const enabledAt=Date.parse(c.financial_ai_enabled_at),createdAt=Date.parse(input.createdAt)
 if(c.financial_ai_enabled!==true || c.cobranca_whatsapp_ativa!==true || !Number.isFinite(enabledAt) || !Number.isFinite(createdAt) || createdAt<enabledAt || !dentroDaJanela({horaInicio:9,horaFim:17,somenteDiasUteis:true}))return false
 const stateContact=await contact(input)
 if(stateContact.human===true)return false
 const unfinished=await checked(db.from('financial_ai_runs').select('id').eq('phone',input.phone).in('status',['reserved','sending','uncertain']).neq('message_id',input.id).limit(1).maybeSingle())
 if(unfinished)return false
 const cap=await db.from('financial_ai_runs').select('id',{head:true,count:'exact'}).eq('phone',input.phone).neq('message_id',input.id).in('status',['sent','sending','uncertain']).gte('created_at',new Date(Date.now()-86400000).toISOString()).abortSignal(AbortSignal.timeout(10000))
 if(cap.error || cap.count>=3)return false
 const sync=await verificarFrescorSync()
 if(!sync.allowed || sync.reason==='guard_desabilitado' || (await estaEmDoNotContact(input.phone)).blocked)return false
 const channel=await checked(db.from('whatsapp_instances').select('enabled,role').eq('instance_name',input.instance).maybeSingle())
 if(!channel?.enabled || !['principal','reserva'].includes(channel.role) || await whatsappTransportFor(input.instance)!=='fzap')return false
 const latest=await checked(db.from('whatsapp_mensagens').select('id,direcao').eq('telefone',input.phone).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(1).maybeSingle())
 if(latest?.id!==input.id || latest.direcao!=='entrada')return false
 const outbound=await checked(db.from('whatsapp_mensagens').select('evolution_id,mensagem,created_at').eq('telefone',input.phone).eq('direcao','saida').gte('created_at',c.financial_ai_enabled_at).order('created_at',{ascending:false}).limit(1).maybeSingle())
 if(outbound && !(stateContact.reason==='operator_released'&&Date.parse(stateContact.updated_at)>Date.parse(outbound.created_at)) && !await knownFinancialOutbound({phone:input.phone,providerId:outbound.evolution_id,text:outbound.mensagem,createdAt:outbound.created_at}))return false
 const state=await client.get('/instance/connectionState/'+encodeURIComponent(input.instance))
 return state.data?.instance?.state==='open'
}
export const processFinancialInbound=createFinancialInboundProcessor({
 async load(event) {
  const id=event?.id
  if(typeof id!=='string')return null
  const m=await checked(db.from('whatsapp_mensagens').select('id,telefone,mensagem,instance_name,direcao,media_tipo,created_at').eq('evolution_id',id).maybeSingle())
  if(!m || m.direcao!=='entrada' || !/^55\d{10,11}$/.test(m.telefone||'') || !m.mensagem?.trim()&&!m.media_tipo)return null
  const input={id:m.id,phone:m.telefone,text:String(m.mensagem||'').slice(0,4000),media:!!m.media_tipo,instance:m.instance_name,createdAt:m.created_at,pix:process.env.CHAVE_PIX_VIVENZZA?.replace(/\D/g,'')}
  if(isStopRequest(input.text)) {
   await contact(input);await markFinancialHuman(input.phone,'opt_out')
   await checked(db.from('collection_do_not_contact').upsert({cliente_telefone:input.phone,motivo:'pedido_parar',canal:'todos',expira_em:null},{onConflict:'cliente_telefone,canal'}));return null
  }
  const c=await config();if(c.financial_ai_enabled!==true)return null
  const timestamp=Number(event.timestamp)*1000
  const enabledAt=Date.parse(c.financial_ai_enabled_at),createdAt=Date.parse(m.created_at)
  if(!Number.isFinite(timestamp) || !Number.isFinite(enabledAt) || !Number.isFinite(createdAt) || Math.abs(Date.now()-timestamp)>300000 || timestamp<enabledAt || createdAt<enabledAt)return null
  return input
 },
 async claim(input){const r=await db.from('financial_ai_runs').insert({message_id:input.id,instance_name:input.instance,phone:input.phone}).select('id').single().abortSignal(AbortSignal.timeout(10000));if(r.error?.code==='23505')return null;if(r.error)throw Error('CLAIM_FAILED');return r.data.id},
 guard,
 async classify(input){
  const ai=new Anthropic({apiKey:process.env.ANTHROPIC_API_KEY,timeout:20000,maxRetries:0})
  const r=await ai.messages.create({model:'claude-sonnet-4-6',max_tokens:150,system:CLASSIFY_SYSTEM_PROMPT,messages:[{role:'user',content:input.text}]})
  try {const result=validarClassificacao(JSON.parse(r.content.filter(x=>x.type==='text').map(x=>x.text).join('')));return result?{...result,cliente_irritado:result.clienteIrritado}:null}catch{return null}
 },
 async prepare(run,input){
  // Reuses the installed, shared budget trigger: global/per-channel quota; paused budget never bypasses it.
  const reserved=await checked(db.rpc('financial_reserve_budget',{p_instancia:input.instance}))
  if(!reserved)throw Error('BUDGET_NOT_READY')
  await checked(db.from('financial_ai_runs').update({status:'sending',attempted_at:new Date().toISOString()}).eq('id',run).eq('status','reserved').select('id').single())
 },
 async send(input,text){const result=await client.post('/message/sendText/'+encodeURIComponent(input.instance),{number:input.phone,text});return {providerId:result.data?.key?.id}},
 async finish(id,status,reason,providerId=null){await checked(db.from('financial_ai_runs').update({status,reason,provider_message_id:providerId,finished_at:new Date().toISOString()}).eq('id',id).in('status',['reserved','sending']).select('id').single())},
 async handoff(input,reason){await contact(input);await markFinancialHuman(input.phone,reason)},
})

async function knownFinancialOutbound({phone,providerId,text,createdAt}) {
 if(typeof providerId!=='string')return false
 for(const table of ['financial_ai_runs','financial_manual_sends','collection_dispatch_attempts']){
  const row=await checked(db.from(table).select('id').eq('provider_message_id',providerId).limit(1).maybeSingle())
  if(row)return true
 }
 const billing=await checked(db.from('cobrancas_whatsapp').select('cliente_telefone,mensagem_enviada').gte('data_envio',new Date((Date.parse(createdAt)||Date.now())-120000).toISOString()).lte('data_envio',new Date((Date.parse(createdAt)||Date.now())+120000).toISOString()).order('data_envio',{ascending:false}).limit(100))
 return billing.some(x=>telefonesEquivalentes(x.cliente_telefone,phone)&&x.mensagem_enviada===text)
}
export async function observeFinancialOutbound({phone,instance,providerId,text}) {
 if(!/^55\d{10,11}$/.test(phone||'') || typeof providerId!=='string')return
 await new Promise(resolve=>setTimeout(resolve,15000))
 if(await knownFinancialOutbound({phone,providerId,text}))return
 const input={phone,instance};await contact(input);await markFinancialHuman(phone,'operator_outbound')
}
