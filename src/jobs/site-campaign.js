import { createHash } from 'node:crypto'
import { createWhatsappProviderClient, WhatsappProviderError } from '../lib/whatsappProviderClient.js'
import { supabase } from '../lib/supabase-admin.server.js'
import { candidatosTelefone, telefonesEquivalentes, normalizarTelefone, paraJidWhatsapp } from '../lib/telefone.js'
import { SITE_CAMPAIGN } from '../lib/siteCampaignPolicy.js'
// Durable queue identity is preserved: no replay of past/uncertain recipients.
export const CAMPAIGN_ID = 'volte10_20261023'
const UNCERTAIN_WINDOW_MS = 30 * 60_000
const TEMPLATE = "Oi, [nome]! Tudo bem? 🖤 Aqui é da Vivenzza Professional.\n\nA Black Vivenzza chegou à nossa loja online! Aproveite 20% OFF em compras acima de R$ 200 com o cupom BLACKVIVENZZA.\n\n👉 https://loja.vivenzzaprofessional.com.br/discount/BLACKVIVENZZA\n\nVálido até 30/11/2026, às 23h59 (Brasília). Um uso por cliente, não cumulativo com outras promoções. Frete não incluído no desconto nem no valor mínimo.\n\nQuer ajuda para escolher os produtos? Responda por aqui e nossa equipe te ajuda.\n\nPara não receber mais ofertas, responda SAIR."
export function campaignMessage(name) {
 const first = String(name || '').trim().split(/\s+/)[0].replace(/[\r\n]/g,'').slice(0,60)
 return TEMPLATE.replace('[nome]',first || 'tudo bem')
}
export async function checkSiteRecipient(api,instance,phone){
 const numbers=[...new Set(candidatosTelefone(paraJidWhatsapp(normalizarTelefone(phone)||'')).filter(n=>/^55\d{10,11}$/.test(n)))]
 if(!numbers.length)throw Error('invalid_recipient_phone')
 const {data:checks}=await api.post('/chat/whatsappNumbers/'+encodeURIComponent(instance),{numbers})
 if(!Array.isArray(checks))throw Error('invalid_number_check')
 const results=numbers.map(number=>{
  const rows=checks.filter(row=>String(row.number||'').replace(/\D/g,'')===number)
  if(rows.length!==1 || typeof rows[0].exists!=='boolean')throw Error('invalid_number_check')
  return rows[0]
 })
 const positives=results.filter(row=>row.exists)
 if(!positives.length)return {exists:false}
 const jids=positives.map(row=>{const number=String(row.jid||'').split('@')[0];if(!/^\d{10,15}@s\.whatsapp\.net$/.test(row.jid||'') || !telefonesEquivalentes(number,phone))throw Error('invalid_recipient_jid');return number})
 if(new Set(jids).size!==1)throw Error('ambiguous_recipient_jid')
 return {exists:true,number:jids[0]}
}
export function campaignSendId(contactId) {
 return 'VZBLACK' + createHash('sha256').update(CAMPAIGN_ID + ':' + contactId).digest('hex').slice(0,32).toUpperCase()
}
// This only observes the original operation. Neither unknown nor not_found
// permits another POST, another ID or a fallback WhatsApp instance.
export async function observeCampaignSend(api,instance,id) {
 try { return (await api.observeSend(instance,id)).state === 'sent' } catch { return false }
}
export function createSiteCampaignWorker({db, api, env, mediaUrl}) {
 return async function run() {
  if (env.SDR_SITE_ENABLED !== 'true' || !env.SDR_SITE_INSTANCE || Date.now()>Date.parse(SITE_CAMPAIGN.expiresAt)) return {status:'disabled'}
  const {data: cfg,error: cfgError}=await db.from('site_campaign_config').select('*').eq('id',CAMPAIGN_ID).maybeSingle()
  if(cfgError) throw new Error('site_campaign_config_failed')
  if(!cfg?.enabled || Date.parse(cfg.expires_at) !== Date.parse(SITE_CAMPAIGN.expiresAt) || !cfg.ai_verified || cfg.instance_name!==env.SDR_SITE_INSTANCE || cfg.instance_name===(env.EVOLUTION_INSTANCE || 'vivenzza')) return {status:'disabled'}
  // Reconcile only IDs durably assigned by this worker, without sending again.
  const uncertain=await db.from('site_campaign_contacts').select('id,evolution_id,lead_id,telefone,nome,reserved_at,status')
   .eq('campaign_id',CAMPAIGN_ID).in('status',['uncertain','reserved']).not('evolution_id','is',null)
   .lt('reserved_at',new Date(Date.now()-10*60_000).toISOString())
   .order('reserved_at',{ascending:false}).limit(100)
  if(uncertain.error) throw Error('site_campaign_reconciliation_lookup_failed')
  for(const prior of uncertain.data||[]){
   if(prior.evolution_id!==campaignSendId(prior.id) || !await observeCampaignSend(api,cfg.instance_name,prior.evolution_id))continue
   const logged=await db.from('whatsapp_mensagens').upsert({lead_id:prior.lead_id,telefone:prior.telefone,
    mensagem:campaignMessage(prior.nome),direcao:'saida',status:'enviado',evolution_id:prior.evolution_id,
    instance_name:cfg.instance_name,media_tipo:'image',media_url:mediaUrl,created_at:prior.reserved_at},
    {onConflict:'evolution_id',ignoreDuplicates:true})
   if(logged.error) throw Error('site_campaign_reconciliation_log_failed')
   const saved=await db.from('site_campaign_contacts').update({status:'sent',sent_at:prior.reserved_at,last_error:null})
    .eq('id',prior.id).eq('status',prior.status).eq('reserved_at',prior.reserved_at).eq('evolution_id',prior.evolution_id)
   if(saved.error) throw Error('site_campaign_reconciliation_save_failed')
  }
  // Bounded circuit breaker: keep ambiguous contacts quarantined, then allow
  // NEW pending contacts after cooldown. Never turn a manual pause back on.
  const recentUnknown = await db.from('site_campaign_contacts').select('id',{head:true,count:'exact'})
   .eq('campaign_id',CAMPAIGN_ID).eq('status','uncertain')
   .gte('reserved_at',new Date(Date.now()-UNCERTAIN_WINDOW_MS).toISOString())
  if(recentUnknown.error) throw Error('site_campaign_cooldown_lookup_failed')
  if(recentUnknown.count >= 2) return {status:'cooldown'}
  const {data,error}=await db.rpc('claim_site_campaign_contact')
  if(error) throw new Error('site_campaign_claim_failed')
  const contact=data?.[0]
  if(!contact) return {status:'waiting'}
  const pause=async(code,uncertain=true)=>{
   await db.from('site_campaign_config').update({enabled:false}).eq('id',CAMPAIGN_ID)
   await db.from('site_campaign_contacts').update({status:uncertain?'uncertain':'pending',last_error:code}).eq('id',contact.id).eq('status','reserved')
  }
  // Recheck all local/ninth-digit variants immediately before provider I/O.
  const {data: leads,error: leadError}=await db.rpc('site_campaign_leads_for_contact',{p_lead_id:contact.lead_id,p_phones:candidatosTelefone(contact.telefone)})
  const linked=leads?.find(l=>l.id===contact.lead_id)
  if(leadError || !linked || !telefonesEquivalentes(linked.telefone,contact.telefone)){await pause('contact_lookup_failed');return {status:'paused'}}
  if(leads.some(l=>l.whatsapp_opt_out || l.atendimento_humano || !l.ativo)){
   const {error:e}=await db.from('site_campaign_contacts').update({status:'blocked'}).eq('id',contact.id)
   if(e) throw new Error('site_campaign_block_persistence_failed')
   return {status:'blocked'}
  }
  // A definitive recipient rejection must not stop unrelated recipients.
  // Unknown/malformed checks still pause; never retry uncertain sends.
  let recipient
  try {recipient=await checkSiteRecipient(api,cfg.instance_name,contact.telefone)}
  catch (error) {
   // No message was attempted. Only a transient provider lookup failure is
   // eligible for another check through the durable queue's normal cadence.
   if (error instanceof WhatsappProviderError && error.code === 'FZAP_UNAVAILABLE') {
    const released = await db.from('site_campaign_contacts')
     .update({status:'pending',last_error:'recipient_check_deferred'})
     .eq('id',contact.id).eq('status','reserved').eq('reserved_at',contact.reserved_at)
     .is('sent_at',null).is('evolution_id',null).select('id').maybeSingle()
    if (!released.error && released.data?.id === contact.id) return {status:'deferred'}
    // Never release an unverified reservation or overwrite a concurrent reply.
    await db.from('site_campaign_config').update({enabled:false}).eq('id',CAMPAIGN_ID)
    return {status:'paused'}
   }
   await pause('recipient_check_unavailable',false);return {status:'paused'}
  }
  if(!recipient.exists){
   try{const {data:state}=await api.get('/instance/connectionState/'+encodeURIComponent(cfg.instance_name));if(state.instance?.state!=='open')throw Error('instance_not_open')}
   catch{await pause('recipient_check_instance_unavailable',false);return {status:'paused'}}
   const {error:e}=await db.from('site_campaign_contacts').update({status:'blocked',last_error:'recipient_not_on_whatsapp'}).eq('id',contact.id).eq('status','reserved')
   if(e){await pause('recipient_block_persistence_failed',false);return {status:'paused'}}
   return {status:'blocked'}
  }
  const {data: latest,error: latestError}=await db.from('site_campaign_config').select('enabled,ai_verified,instance_name,expires_at').eq('id',CAMPAIGN_ID).single()
  if(latestError || Date.parse(latest?.expires_at) !== Date.parse(SITE_CAMPAIGN.expiresAt) || !latest.enabled || !latest.ai_verified || latest.instance_name!==cfg.instance_name || Date.now()>Date.parse(SITE_CAMPAIGN.expiresAt)){await pause('preflight_changed');return {status:'paused'}}
  const {data: current,error: currentError}=await db.from('site_campaign_contacts').select('status').eq('id',contact.id).single()
  if(currentError){await pause('recipient_preflight_failed');return {status:'paused'}}
  if(current.status!=='reserved') return {status:'cancelled'}
  const text=campaignMessage(contact.nome)
  const intentId=campaignSendId(contact.id)
  // Save the immutable correlation ID before external I/O. A failed CAS or
  // unconfirmed persistence prohibits sending; reserved rows are never claimed again.
  const intent=await db.from('site_campaign_contacts').update({evolution_id:intentId})
   .eq('id',contact.id).eq('status','reserved').eq('reserved_at',contact.reserved_at)
   .is('sent_at',null).is('evolution_id',null).select('id').maybeSingle()
  if(intent.error || intent.data?.id!==contact.id){await pause('send_intent_persistence_failed');return {status:'paused'}}
  let id
  try {
   const {data: sent}=await api.post('/message/sendMedia/'+encodeURIComponent(cfg.instance_name),{clientMessageId:intentId,number:recipient.number,mediatype:'image',mimetype:'image/png',media:mediaUrl,fileName:'Vivenzza-BLACK-3011.png',caption:text})
   id=sent?.key?.id
   if(id!==intentId) throw new Error('mismatched_provider_id')
  } catch (error) {
   if(await observeCampaignSend(api,cfg.instance_name,intentId)) id=intentId
   else {
    const failure=await db.from('site_campaign_contacts').update({status:'uncertain',last_error:'provider_outcome_uncertain'})
     .eq('id',contact.id).eq('status','reserved').eq('evolution_id',intentId).select('id').maybeSingle()
    if(failure.error || failure.data?.id!==contact.id){await pause('uncertain_persistence_unconfirmed');return {status:'paused'}}
    if(!(error instanceof WhatsappProviderError) || error.code!=='FZAP_UNCERTAIN'){
     await db.from('site_campaign_config').update({enabled:false}).eq('id',CAMPAIGN_ID)
     return {status:'paused'}
    }
    try {
     const {data:session}=await api.get('/instance/connectionState/'+encodeURIComponent(cfg.instance_name))
     if(session?.instance?.state!=='open') throw Error('site_session_closed')
    } catch {
     await db.from('site_campaign_config').update({enabled:false}).eq('id',CAMPAIGN_ID)
     return {status:'paused'}
    }
    return {status:'uncertain'}
   }
  }
  const {error: logError}=await db.from('whatsapp_mensagens').upsert({lead_id:contact.lead_id,telefone:contact.telefone,mensagem:text,direcao:'saida',status:'enviado',evolution_id:id,instance_name:cfg.instance_name,media_tipo:'image',media_url:mediaUrl},{onConflict:'evolution_id',ignoreDuplicates:true})
  const {error: saveError}=await db.from('site_campaign_contacts').update({evolution_id:id,sent_at:new Date().toISOString()}).eq('id',contact.id)
  const {error: statusError}=await db.from('site_campaign_contacts').update({status:'sent'}).eq('id',contact.id).eq('status','reserved')
  if(logError || saveError || statusError){await pause('post_send_persistence_failed');return {status:'paused'}}
  return {status:'sent'}
 }
}
const api=createWhatsappProviderClient({baseURL:process.env.EVOLUTION_API_URL,headers:{apikey:process.env.EVOLUTION_API_KEY},timeout:20000},{siteCampaignInstance:process.env.SDR_SITE_INSTANCE})
export const runSiteCampaignQueue=createSiteCampaignWorker({db:supabase,api,env:process.env,mediaUrl:'https://vivenzza-crm-api-production.up.railway.app/widgets/campanhas/black-vivenzza-3011.png'})
