import { createHash } from 'node:crypto'
import { candidatosTelefone, normalizarTelefone, paraJidWhatsapp } from './telefone.js'
import { humanOwnsSdr } from './sdrOwnership.js'

export const LANDING_FLOW = 'landing_lara_v1'
const bounded = q => q.abortSignal(AbortSignal.timeout(8000))
const value = async q => { const r = await bounded(q); if (r.error) throw Error('LANDING_DB_UNCONFIRMED'); return r }
const digest = s => createHash('sha256').update(s).digest('hex')
export function landingIdentity(phone) {
  const digits = normalizarTelefone(phone)
  if (!digits) throw Error('LANDING_INVALID_PHONE')
  const jid = paraJidWhatsapp(digits)
  if (!/^55\d{10,11}$/.test(jid)) throw Error('LANDING_INVALID_PHONE')
  const local = jid.slice(2)
  if (paraJidWhatsapp(local) !== jid) throw Error('LANDING_INVALID_PHONE')
  const canonical = [...new Set(candidatosTelefone(jid))].sort((a,b)=>a.length-b.length || a.localeCompare(b))[0]
  const hash = digest(LANDING_FLOW + ':' + canonical)
  const id = hash.slice(0,8)+'-'+hash.slice(8,12)+'-4'+hash.slice(13,16)+'-a'+hash.slice(17,20)+'-'+hash.slice(20,32)
  return { phone: digits, jid, candidates: candidatosTelefone(jid), leadId:id, messageId:'VZLP'+hash.slice(0,32).toUpperCase() }
}
export function landingGreeting(name,interest) {
  const first = String(name||'').trim().split(/\s+/)[0].slice(0,50)
  const distributor = interest === 'Distribuidor'
  return `Oi${first ? ', '+first : ''}! Sou a Lara, assistente virtual comercial da Vivenzza Professional. Recebi seu cadastro no nosso site e vou te ajudar a conhecer a parceria.\n\n${distributor ? 'Você já atende salões na sua região ou está começando na distribuição?' : 'Você procura produtos para usar no salão ou para revender?'}\n\nSe preferir falar com nossa equipe, é só pedir. Para não receber mensagens, responda SAIR.`
}
export function landingConsent(body,origin) {
  if (body?.whatsapp_consent !== true || origin !== 'https://distribuidores.vivenzzaprofessional.com.br') return false
  try { return new URL(body.event_source_url).origin === origin } catch { return false }
}
export async function enqueueLandingLara({db,lead,identity,interest,evidence={}}) {
  // Only leads created by this form implementation can start this new flow.
  if(lead.id!==identity.leadId)return false
  if (await humanOwnsSdr({db,table:'sdr_conversas',phone:identity.jid})) return false
  const existing = await value(db.from('whatsapp_mensagens').select('id').eq('evolution_id',identity.messageId).maybeSingle())
  if (existing.data) return false
  const r = await bounded(db.from('whatsapp_mensagens').insert({lead_id:lead.id,telefone:identity.phone,
    mensagem:landingGreeting(lead.nome,interest),direcao:'saida',status:'pendente',evolution_id:identity.messageId,
    instance_name:'vivenzza',media_data:{flow:LANDING_FLOW,phase:'queued',interest,consent:true,
      submitted_at:new Date().toISOString(),consent_version:'landing-whatsapp-v1',name:String(lead.nome||'').slice(0,150),...evidence}}))
  if (r.error && r.error.code !== '23505') throw Error('LANDING_QUEUE_UNCONFIRMED')
  return !r.error
}

// One persistent intent per telephone. Only queued/preflight failures can retry.
// A timeout, crash after dispatch reservation, or missing receipt never authorizes another send.
export function createLandingLaraWorker({db,api,now=()=>new Date()}) {
  let running=false
  return async function run() {
    if(running)return {status:'busy'}
    running=true
    let row,dispatching=false,accepted=false
    const finish=async(status,phase)=>value(db.from('whatsapp_mensagens').update({status,media_data:{...row.media_data,phase}})
      .eq('id',row.id).eq('status','processando'))
    try {
      const cfg=await value(db.from('automacoes_config').select('sdr_ativo').eq('id',1).single())
      if(cfg.data?.sdr_ativo!==true)return {status:'disabled'}
      const connection=await value(db.from('whatsapp_connections').select('instance_name,owner,finalidade').eq('id','comercial').single())
      if(connection.data?.instance_name!=='vivenzza'||connection.data.owner!=='fzap'||connection.data.finalidade!=='comercial')return {status:'unavailable'}
      const stamp=now(),day=new Date(stamp);day.setUTCHours(3,0,0,0);if(day>stamp)day.setUTCDate(day.getUTCDate()-1)
      // Recover a process crash only when no external send was ever reserved.
      const stale=await value(db.from('whatsapp_mensagens').select('id,media_data').eq('media_data->>flow',LANDING_FLOW)
        .eq('status','processando').eq('media_data->>phase','queued').lt('media_data->>claimed_at',new Date(stamp-15*60000).toISOString()).limit(20))
      for(const prior of stale.data){await value(db.from('whatsapp_mensagens').update({status:'pendente'})
        .eq('id',prior.id).eq('status','processando').eq('media_data->>phase','queued').eq('media_data->>claimed_at',prior.media_data.claimed_at))}
      const orphaned=await value(db.from('whatsapp_mensagens').update({status:'incerto'})
        .eq('media_data->>flow',LANDING_FLOW).eq('status','processando').eq('media_data->>phase','dispatching')
        .lt('created_at',new Date(stamp-15*60000).toISOString()).select('id'))
      if(orphaned.data.length)return {status:'uncertain'}
      // Count all commercial traffic, not just this flow; never amplify an existing burst.
      for(const [since,limit,own] of [[new Date(stamp-5*60000),15,false],[new Date(stamp-60000),1,true],[new Date(stamp-3600000),10,true],[day,50,true]]){
        let query=db.from('whatsapp_mensagens').select('id',{count:'exact',head:true}).eq('instance_name','vivenzza')
          .eq('direcao','saida').in('status',['enviado','entregue','lido','processando','incerto']).gte('created_at',since.toISOString())
        if(own)query=query.eq('media_data->>flow',LANDING_FLOW)
        const count=await value(query)
        if(count.count>=limit)return {status:'paced'}
      }
      const next=await value(db.from('whatsapp_mensagens').select('*').eq('media_data->>flow',LANDING_FLOW)
        .eq('status','pendente').order('created_at',{ascending:true}).limit(1).maybeSingle())
      row=next.data;if(!row)return {status:'waiting'}
      if(!Number.isFinite(Date.parse(row.media_data?.submitted_at))||stamp-Date.parse(row.media_data.submitted_at)>24*3600000){
        await value(db.from('whatsapp_mensagens').update({status:'cancelado',media_data:{...row.media_data,phase:'expired'}}).eq('id',row.id).eq('status','pendente'))
        return {status:'expired'}
      }
      row.media_data={...row.media_data,claimed_at:stamp.toISOString()}
      const claim=await value(db.from('whatsapp_mensagens').update({status:'processando',created_at:stamp.toISOString(),media_data:row.media_data})
        .eq('id',row.id).eq('status','pendente').select('id').maybeSingle())
      if(!claim.data)return {status:'claimed_elsewhere'}
      const parallel=await value(db.from('whatsapp_mensagens').select('id',{count:'exact',head:true})
        .eq('instance_name','vivenzza').eq('direcao','saida').neq('id',row.id)
        .in('status',['enviado','entregue','lido','processando','incerto']).gte('created_at',new Date(stamp-60000).toISOString()))
      if(parallel.count>=15){await finish('pendente','queued');return {status:'paced'}}
      const identity=landingIdentity(row.telefone)
      if(identity.messageId!==row.evolution_id||row.media_data?.consent!==true){await finish('bloqueado','invalid_intent');return {status:'blocked'}}
      const preflight=async()=>{
        if(await humanOwnsSdr({db,table:'sdr_conversas',phone:identity.jid}))return false
        const lead=await value(db.from('leads').select('id,telefone,responsavel_id').eq('id',row.lead_id).single())
        if(!lead.data?.responsavel_id||!identity.candidates.includes(lead.data.telefone))throw Error('LANDING_LEAD_UNCONFIRMED')
        const activity=await value(db.from('whatsapp_mensagens').select('id').in('telefone',identity.candidates)
          .eq('instance_name','vivenzza').neq('id',row.id).in('status',['recebido','enviado','entregue','lido','incerto','processando']).limit(1))
        const conversation=await value(db.from('sdr_conversas').select('telefone').in('telefone',identity.candidates).limit(1))
        return !activity.data.length&&!conversation.data.length
      }
      if(!await preflight()){await finish('cancelado','existing_contact_or_human');return {status:'blocked'}}
      const {data:state}=await api.get('/instance/connectionState/vivenzza')
      if(state?.instance?.state!=='open')throw Error('LANDING_INSTANCE_UNAVAILABLE')
      // Recipient lookup failures occur before any send and may safely defer.
      const {data:checks}=await api.post('/chat/whatsappNumbers/vivenzza',{numbers:[identity.jid]})
      if(!Array.isArray(checks)||checks.length!==1||typeof checks[0].exists!=='boolean')throw Error('LANDING_RECIPIENT_UNCONFIRMED')
      if(!checks[0].exists){await finish('bloqueado','not_on_whatsapp');return {status:'blocked'}}
      const recipient=String(checks[0].jid||'').split('@')[0]
      if(!identity.candidates.includes(recipient))throw Error('LANDING_RECIPIENT_UNCONFIRMED')
      const active=await value(db.from('automacoes_config').select('sdr_ativo').eq('id',1).single())
      if(active.data?.sdr_ativo!==true||!await preflight()){await finish('cancelado','preflight_changed');return {status:'blocked'}}
      await value(db.from('whatsapp_mensagens').update({created_at:stamp.toISOString(),media_data:{...row.media_data,phase:'dispatching'}})
        .eq('id',row.id).eq('status','processando').select('id').single())
      dispatching=true
      const {data:sent}=await api.post('/message/sendText/vivenzza',{number:recipient,text:row.mensagem,clientMessageId:row.evolution_id})
      if(sent?.key?.id!==row.evolution_id)throw Error('LANDING_SEND_UNCONFIRMED')
      accepted=true
      // Receipt webhooks may already have promoted the status; never downgrade them.
      await value(db.from('whatsapp_mensagens').update({status:'enviado',media_data:{...row.media_data,phase:'sent'}})
        .eq('id',row.id).eq('status','processando'))
      if(!await humanOwnsSdr({db,table:'sdr_conversas',phone:identity.jid})){
        const seed=await bounded(db.from('sdr_conversas').insert({telefone:identity.jid,estado:'qualificando',tipo_lead:row.media_data.interest==='Distribuidor'?'distribuidor':'indefinido',
          status_atendimento:'ia_atendendo',nome_cliente:row.media_data.name||null,ultimo_contato:stamp.toISOString(),
          historico:[{role:'assistant',content:row.mensagem,timestamp:stamp.toISOString()}]}))
        if(seed.error&&seed.error.code!=='23505')throw Error('LANDING_CONTEXT_UNCONFIRMED')
      }
      return {status:'sent'}
    }catch{
      if(row){try{await finish(dispatching?'incerto':'pendente',dispatching?'uncertain':'queued')}catch{}}
      return {status:accepted?'sent_context_pending':dispatching?'uncertain':'deferred'}
    }finally{running=false}
  }
}

export async function stopLandingLara({db,phone}){
 const identity=landingIdentity(phone)
 const intent=await value(db.from('whatsapp_mensagens').select('id').eq('evolution_id',identity.messageId).maybeSingle())
 if(!intent.data)return false
 await value(db.from('leads').update({whatsapp_opt_out:true,whatsapp_opt_out_em:new Date().toISOString(),whatsapp_opt_out_motivo:'pedido_recebido_whatsapp'})
  .in('telefone',identity.candidates))
 await value(db.from('whatsapp_mensagens').update({status:'cancelado'}).eq('id',intent.data.id).eq('status','pendente'))
 return true
}
