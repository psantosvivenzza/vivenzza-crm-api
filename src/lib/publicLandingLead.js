import { landingIdentity, landingConsent, enqueueLandingLara } from './landingLara.js'
import { createHash } from 'node:crypto'
const bounded=q=>q.abortSignal(AbortSignal.timeout(8000))
const required=async q=>{const r=await bounded(q);if(r.error)throw Error('LANDING_SAVE_UNCONFIRMED');return r}
export function createPublicLandingLeadHandler({db,nextSeller,capi}){
 return async(req,res)=>{
  const b=req.body||{}
  if(typeof b.nome!=='string'||!b.nome.trim()||b.nome.length>150)return res.status(400).json({erro:'Informe um nome válido.'})
  if(typeof b.telefone!=='string'||b.telefone.length>30)return res.status(400).json({erro:'Informe um WhatsApp com DDD válido.'})
  let identity
  try{identity=landingIdentity(b.telefone)}catch{return res.status(400).json({erro:'Informe um WhatsApp com DDD ou código de país válido.'})}
  const consent=landingConsent(b,req.headers.origin)
  if(b.website)return res.status(400).json({erro:'Não foi possível validar o formulário.'})
  const interest=['Distribuidor','Salão','Salão de Beleza','Revendedor'].includes(b.interesse)?b.interesse:null
  const campaign=typeof b.campanha_origem==='string'?b.campanha_origem.slice(0,120)||'landing_direto':'landing_direto'
  try{
   const found=await required(db.from('leads').select('id,nome,telefone,responsavel_id').in('telefone',identity.candidates).order('criado_em',{ascending:true}).limit(1).maybeSingle())
   let lead=found.data,created=false
   if(!lead){
    const saved=await bounded(db.from('leads').insert({id:identity.leadId,nome:b.nome.trim(),telefone:identity.phone,
     tipo:'distribuidor',etapa:'novo',origem:campaign.toLowerCase().startsWith('meta_')?'whatsapp':campaign.toLowerCase()==='instagram'?'instagram':'site',campanha_origem:campaign,
     observacoes:[typeof b.cidade==='string'?`Cidade/Estado: ${b.cidade.slice(0,150)}`:null,interest?`Interesse: ${interest}`:null].filter(Boolean).join(' | ')||null})
     .select('id,nome,telefone,responsavel_id').single())
    if(saved.error&&saved.error.code!=='23505')throw Error('LANDING_SAVE_UNCONFIRMED')
    created=!saved.error
    lead=saved.data || (await required(db.from('leads').select('id,nome,telefone,responsavel_id').eq('id',identity.leadId).single())).data
   }
   if(!lead.responsavel_id){
    const seller=await nextSeller()
    if(seller){const assigned=await required(db.from('leads').update({responsavel_id:seller.id}).eq('id',lead.id).is('responsavel_id',null).select('id,responsavel_id').maybeSingle());if(assigned.data)lead.responsavel_id=assigned.data.responsavel_id}
   }
   const contact=await required(db.from('contatos').select('id').eq('lead_id',lead.id).in('telefone',identity.candidates).limit(1))
   if(!contact.data.length){const savedContact=await bounded(db.from('contatos').insert({id:lead.id,lead_id:lead.id,nome:lead.nome,telefone:lead.telefone,principal:true}));if(savedContact.error&&savedContact.error.code!=='23505')throw Error('LANDING_CONTACT_UNCONFIRMED')}
   if(consent)await enqueueLandingLara({db,lead,identity,interest,evidence:{source:'https://distribuidores.vivenzzaprofessional.com.br/',
    ip_hash:createHash('sha256').update(String(req.ip||'unknown')).digest('hex'),user_agent:String(req.headers['user-agent']||'').slice(0,180)}})
   if(created)Promise.resolve().then(()=>capi({event_id:b.event_id,event_source_url:b.event_source_url,telefone:identity.phone,
    email:typeof b.email==='string'?b.email.slice(0,200):null,client_ip:req.headers['x-forwarded-for']?.split(',')[0]?.trim()||req.ip,user_agent:req.headers['user-agent']||''})).catch(()=>{})
   return res.status(201).json({ok:true})
  }catch{console.error('[landing-lara] registration_unconfirmed');return res.status(503).json({erro:'Não foi possível confirmar o cadastro. Tente novamente.'})}
 }
}
