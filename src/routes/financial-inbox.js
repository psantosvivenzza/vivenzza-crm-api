import {Router} from 'express'
import {supabase as db} from '../lib/supabase-admin.server.js'
import {createWhatsappProviderClient,whatsappTransportFor} from '../lib/whatsappProviderClient.js'
import {estaEmDoNotContact} from '../lib/collection/doNotContactGuard.js'
import {dentroDaJanela} from '../lib/collection/collectionContactPolicy.js'
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const checked=async q=>{const r=await q.abortSignal(AbortSignal.timeout(10000));if(r.error)throw Error('FINANCIAL_INBOX_STORAGE');return r.data}
const client=createWhatsappProviderClient({})
const router=Router()
router.use((req,res,next)=>{res.set('Cache-Control','no-store');if(!['admin','financeiro'].includes(req.user?.role)||!uuid.test(req.user?.id||''))return res.status(403).json({erro:'Acesso restrito ao financeiro.'});next()})
const handle=fn=>async(req,res)=>{try{await fn(req,res)}catch{res.status(503).json({erro:'Operação financeira indisponível. Atualize para conferir o estado; não repita envio sem confirmação.'})}}
router.get('/',handle(async(req,res)=>{
 const rows=await checked(db.from('financial_ai_contacts').select('id,phone,instance_name,human,reason,updated_at').order('updated_at',{ascending:false}).limit(100))
 res.json({data:rows})
}))
router.get('/:id',handle(async(req,res)=>{
 if(!uuid.test(req.params.id))return res.status(400).json({erro:'Atendimento inválido.'})
 const contact=await checked(db.from('financial_ai_contacts').select('*').eq('id',req.params.id).single())
 const messages=await checked(db.from('whatsapp_mensagens').select('id,mensagem,direcao,created_at,media_tipo').eq('telefone',contact.phone).eq('instance_name',contact.instance_name).order('created_at',{ascending:false}).limit(100))
 res.json({contact,messages:messages.reverse()})
}))
router.patch('/:id/humano',handle(async(req,res)=>{
 if(!uuid.test(req.params.id)||typeof req.body?.humano!=='boolean'||typeof req.body?.esperado!=='boolean'||typeof req.body?.versao!=='string'||!Number.isFinite(Date.parse(req.body.versao)))return res.status(400).json({erro:'Informe estado e versão atuais.'})
 // Uncertain or interrupted delivery requires reconciliation, not a resume toggle.
 const contact=await checked(db.from('financial_ai_contacts').select('phone').eq('id',req.params.id).single())
 if(!req.body.humano){const pendingManual=await checked(db.from('financial_manual_sends').select('id').eq('contact_id',req.params.id).in('status',['reserved','uncertain']).limit(1).maybeSingle());if(pendingManual)return res.status(409).json({erro:'Há envio manual sem confirmação. Confira o resultado antes de devolver à IA.'});const uncertain=await checked(db.from('financial_ai_runs').select('id').eq('phone',contact.phone).in('status',['reserved','sending','uncertain']).limit(1).maybeSingle());if(uncertain)return res.status(409).json({erro:'Há envio sem confirmação. Confira o resultado antes de devolver à IA.'})}
 const r=await db.from('financial_ai_contacts').update({human:req.body.humano,reason:req.body.humano?'operator':'operator_released',updated_at:new Date().toISOString()}).eq('id',req.params.id).eq('human',req.body.esperado).eq('updated_at',req.body.versao).select('id,human,updated_at').maybeSingle().abortSignal(AbortSignal.timeout(10000))
 if(r.error)throw Error('SAVE_FAILED');if(!r.data)return res.status(409).json({erro:'O atendimento mudou. Atualize antes de alterar.'});res.json(r.data)
}))
router.post('/:id/enviar',handle(async(req,res)=>{
 const {request_id,texto}=req.body||{}
 if(!uuid.test(req.params.id)||!uuid.test(request_id||'')||typeof texto!=='string'||!texto.trim()||texto.length>2000)return res.status(400).json({erro:'Informe mensagem e identificador válidos.'})
 const c=await checked(db.from('financial_ai_contacts').select('*').eq('id',req.params.id).single())
 if(!dentroDaJanela({horaInicio:9,horaFim:17,somenteDiasUteis:true})||(await estaEmDoNotContact(c.phone)).blocked)return res.status(409).json({erro:'Envio bloqueado pelo horário ou restrição de contato.'})
 const channel=await checked(db.from('whatsapp_instances').select('enabled,role').eq('instance_name',c.instance_name).maybeSingle())
 if(!['principal','reserva'].includes(channel?.role)||channel.enabled!==true||await whatsappTransportFor(c.instance_name)!=='fzap')return res.status(409).json({erro:'Canal financeiro não está disponível.'})
 const state=await client.get('/instance/connectionState/'+encodeURIComponent(c.instance_name));if(state.data?.instance?.state!=='open')return res.status(409).json({erro:'Canal financeiro desconectado.'})
 await checked(db.from('financial_ai_contacts').update({human:true,reason:'operator',updated_at:new Date().toISOString()}).eq('id',c.id).select('id').single())
 const existing=await checked(db.from('financial_manual_sends').select('status').eq('contact_id',c.id).in('status',['reserved','uncertain']).limit(1).maybeSingle())
 if(existing)return res.status(409).json({erro:'Há uma tentativa sem confirmação neste atendimento. Não reenviar antes de conferir.'})
 // Persist intent before network; same request UUID never sends twice.
 const claim=await db.from('financial_manual_sends').insert({id:request_id,contact_id:c.id}).select('id').single().abortSignal(AbortSignal.timeout(10000))
 if(claim.error?.code==='23505')return res.status(409).json({erro:'Esta solicitação já foi registrada. Atualize o atendimento.'});if(claim.error)throw Error('CLAIM_FAILED')
 let attempted=false
 try {
  const reservation=await checked(db.rpc('financial_reserve_budget',{p_instancia:c.instance_name}));if(!reservation)throw Error('BUDGET_NOT_READY')
  attempted=true
  const sent=await client.post('/message/sendText/'+encodeURIComponent(c.instance_name),{number:c.phone,text:texto.trim()})
  if(!sent.data?.key?.id)throw Error('OUTCOME_UNCERTAIN')
  await checked(db.from('financial_manual_sends').update({status:'sent',provider_message_id:sent.data.key.id}).eq('id',request_id).eq('status','reserved').select('id').single())
  res.json({sucesso:true})
 }catch{
  await checked(db.from('financial_manual_sends').update({status:attempted?'uncertain':'blocked'}).eq('id',request_id).eq('status','reserved'))
  return res.status(attempted?502:409).json({erro:attempted?'Resultado não confirmado. A tentativa está preservada; não reenviar automaticamente.':'Envio não iniciado: limite ou infraestrutura indisponível. Atualize antes de tentar novamente.'})
 }
}))
export default router
