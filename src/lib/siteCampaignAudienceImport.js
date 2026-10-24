import {candidatosTelefone,normalizarTelefone} from './telefone.js'
export const SITE_AUDIENCE_ID='volte10_20261023'
const aliases=p=>candidatosTelefone(normalizarTelefone(p)||'')
export function sourceCreatedAt(value){
 const m=/^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(String(value||''))
 if(!m)return null
 const d=new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]||'00'}:${m[5]||'00'}:${m[6]||'00'}-03:00`)
 if(!Number.isFinite(d.getTime()) || d.getUTCFullYear()!==Number(m[3]) || d.getUTCMonth()+1!==Number(m[2]) || d.getUTCDate()!==Number(m[1]) || d.getTime()>Date.now())return null
 return d.toISOString()
}
function add(index,phone,row){for(const key of aliases(phone)){if(!index.has(key))index.set(key,new Set());index.get(key).add(row)}}
function matching(index,phone){return [...new Set(aliases(phone).flatMap(k=>[...(index.get(k)||[])]))]}
export async function importSiteAudience({repo,contacts,apply=false}){
 if(apply && (await repo.config())?.enabled)throw Error('pause_campaign_before_import')
 const leadIndex=new Map(),registryIndex=new Map(),registryByLead=new Map()
 const suppressed=new Set((await repo.suppressedPhones()).flatMap(aliases))
 for(const l of await repo.leads())add(leadIndex,l.telefone,l)
 for(const c of await repo.recipients()){add(registryIndex,c.telefone,c);registryByLead.set(c.lead_id,c)}
 const report={records:contacts.length,existingLeads:0,newLeads:0,blocked:0,alreadyRegistered:0,eligibleNew:0,inserted:0,blockedExisting:0}
 const seen=new Set()
 for(const c of contacts){
  if(!/^55\d{10,11}$/.test(c.telefone)||!c.nome?.trim())throw Error('invalid_audience_contact')
  if(aliases(c.telefone).some(p=>seen.has(p)))throw Error('audience_must_be_deduplicated')
  aliases(c.telefone).forEach(p=>seen.add(p))
  if(!matching(leadIndex,c.telefone).length && !c.marketing_recusado && !sourceCreatedAt(c.data_cadastro_origem))throw Error('invalid_source_registration_date')
 }
 for(const c of contacts){
  const leads=matching(leadIndex,c.telefone)
  let lead=leads.find(l=>normalizarTelefone(l.telefone)===c.telefone)||leads[0]
  if(lead)report.existingLeads++;else report.newLeads++
  const blocked=c.marketing_recusado===true||aliases(c.telefone).some(p=>suppressed.has(p))||leads.some(l=>l.whatsapp_opt_out||l.atendimento_humano||l.ativo===false)
  const prior=[...new Set([...matching(registryIndex,c.telefone),...leads.map(l=>registryByLead.get(l.id)).filter(Boolean)])]
  if(blocked)report.blocked++
  if(prior.length){
   report.alreadyRegistered++
   if(apply && blocked){const ids=prior.filter(p=>['pending','reserved'].includes(p.status)).map(p=>p.id);if(ids.length){await repo.blockRecipients(ids);report.blockedExisting+=ids.length}}
   continue
  }
  if(blocked)continue
  report.eligibleNew++
  if(!apply)continue
  if(!lead){
   const createdAt=sourceCreatedAt(c.data_cadastro_origem)
   if(!createdAt)throw Error('invalid_source_registration_date')
   lead=await repo.insertLead({nome:c.nome,telefone:c.telefone,origem:'site',tipo:'indefinido',campanha_origem:'site_volte10_20261023',status_reativacao:'encerrado',created_at:createdAt})
   add(leadIndex,lead.telefone,lead)
  }
  const row=await repo.insertRecipient({campaign_id:SITE_AUDIENCE_ID,lead_id:lead.id,nome:c.nome,telefone:c.telefone,status:'pending'})
  add(registryIndex,row.telefone,row);registryByLead.set(row.lead_id,row);report.inserted++
 }
 return {mode:apply?'apply':'preview',...report}
}
