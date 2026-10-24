import axios from 'axios'
import { supabase } from '../lib/supabase-admin.server.js'
import { candidatosTelefone, telefonesEquivalentes } from '../lib/telefone.js'
import { SITE_CAMPAIGN } from '../lib/siteCampaignPolicy.js'
export const CAMPAIGN_ID = 'volte10_20261023'
const TEMPLATE = "Olá, [nome]! Tudo bem? 💗\n\nAqui é da Vivenzza Professional! Passamos para te deixar um presente para o seu pedido:\n\n🎟️ 10% OFF com o cupom VOLTE10\n\nSe estiver em dúvida sobre qual produto escolher, responda por aqui. A gente te ajuda a encontrar o cuidado para o seu cabelo! ✨\n\n👉 https://loja.vivenzzaprofessional.com.br/discount/VOLTE10\n\nVálido até 06/11. Um uso por cliente, não cumulativo com outras promoções."
export function campaignMessage(name) {
 const first = String(name || '').trim().split(/\s+/)[0].replace(/[\r\n]/g,'').slice(0,60)
 return TEMPLATE.replace('[nome]',first || 'tudo bem')
}
export function createSiteCampaignWorker({db, api, env, mediaUrl}) {
 return async function run() {
  if (env.SDR_SITE_ENABLED !== 'true' || !env.SDR_SITE_INSTANCE || Date.now()>Date.parse(SITE_CAMPAIGN.expiresAt)) return {status:'disabled'}
  const {data: cfg,error: cfgError}=await db.from('site_campaign_config').select('*').eq('id',CAMPAIGN_ID).maybeSingle()
  if(cfgError) throw new Error('site_campaign_config_failed')
  if(!cfg?.enabled || !cfg.ai_verified || cfg.instance_name!==env.SDR_SITE_INSTANCE || cfg.instance_name===(env.EVOLUTION_INSTANCE || 'vivenzza')) return {status:'disabled'}
  const {data,error}=await db.rpc('claim_site_campaign_contact')
  if(error) throw new Error('site_campaign_claim_failed')
  const contact=data?.[0]
  if(!contact) return {status:'waiting'}
  const pause=async(code)=>{
   await db.from('site_campaign_config').update({enabled:false}).eq('id',CAMPAIGN_ID)
   await db.from('site_campaign_contacts').update({status:'uncertain',last_error:code}).eq('id',contact.id).eq('status','reserved')
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
  const {data: latest,error: latestError}=await db.from('site_campaign_config').select('enabled,ai_verified,instance_name').eq('id',CAMPAIGN_ID).single()
  if(latestError || !latest.enabled || !latest.ai_verified || latest.instance_name!==cfg.instance_name || Date.now()>Date.parse(SITE_CAMPAIGN.expiresAt)){await pause('preflight_changed');return {status:'paused'}}
  const {data: current,error: currentError}=await db.from('site_campaign_contacts').select('status').eq('id',contact.id).single()
  if(currentError){await pause('recipient_preflight_failed');return {status:'paused'}}
  if(current.status!=='reserved') return {status:'cancelled'}
  const text=campaignMessage(contact.nome)
  let id
  try {
   const {data: sent}=await api.post('/message/sendMedia/'+encodeURIComponent(cfg.instance_name),{number:contact.telefone,mediatype:'image',mimetype:'image/jpeg',media:mediaUrl,fileName:'Vivenzza-VOLTE10-0611.jpg',caption:text})
   id=sent?.key?.id
   if(!id) throw new Error('missing_provider_id')
  } catch {await pause('provider_outcome_uncertain');return {status:'paused'}}
  const {error: logError}=await db.from('whatsapp_mensagens').insert({lead_id:contact.lead_id,telefone:contact.telefone,mensagem:text,direcao:'saida',status:'enviado',evolution_id:id,instance_name:cfg.instance_name,media_tipo:'image',media_url:mediaUrl})
  const {error: saveError}=await db.from('site_campaign_contacts').update({evolution_id:id,sent_at:new Date().toISOString()}).eq('id',contact.id)
  const {error: statusError}=await db.from('site_campaign_contacts').update({status:'sent'}).eq('id',contact.id).eq('status','reserved')
  if(logError || saveError || statusError){await pause('post_send_persistence_failed');return {status:'paused'}}
  return {status:'sent'}
 }
}
const api=axios.create({baseURL:process.env.EVOLUTION_API_URL,headers:{apikey:process.env.EVOLUTION_API_KEY},timeout:20000})
export const runSiteCampaignQueue=createSiteCampaignWorker({db:supabase,api,env:process.env,mediaUrl:'https://vivenzza-crm-api-production.up.railway.app/widgets/campanhas/volte10-0611.jpg'})
