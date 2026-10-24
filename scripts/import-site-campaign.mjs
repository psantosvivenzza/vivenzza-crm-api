import fs from 'node:fs/promises'
import {createClient} from '@supabase/supabase-js'
import {candidatosTelefone} from '../src/lib/telefone.js'
const apply=process.argv.includes('--apply')
const file=process.argv.find(a=>a.startsWith('--file='))?.slice(7)
if(!file) throw Error('missing_input_file')
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
const contacts=JSON.parse(await fs.readFile(file,'utf8'))
const report={records:contacts.length,existing:0,new:0,blocked:0,imported:0}
for(const c of contacts){
 if(!/^55[0-9]{10,11}$/.test(c.telefone) || !c.nome?.trim())throw Error('invalid_contact')
 const {data:found,error}=await db.from('leads').select('id,telefone,whatsapp_opt_out,atendimento_humano,ativo').in('telefone',candidatosTelefone(c.telefone))
 if(error)throw Error('lead_lookup_failed')
 let lead=found?.find(l=>l.telefone===c.telefone) || found?.[0]
 const blocked=found?.some(l=>l.whatsapp_opt_out || l.atendimento_humano || !l.ativo)
 if(lead)report.existing++;else report.new++
 if(blocked)report.blocked++
 if(!apply)continue
 if(!lead){const {data:created,error:ce}=await db.from('leads').insert({nome:c.nome,telefone:c.telefone,origem:'site',tipo:'consumidor_final',campanha_origem:'site_volte10_20261023',status_reativacao:'encerrado'}).select('id').single();if(ce)throw Error('lead_insert_failed');lead=created}
 const {data:prior,error:pe}=await db.from('site_campaign_contacts').select('id').eq('campaign_id','volte10_20261023').eq('lead_id',lead.id).maybeSingle()
 if(pe)throw Error('registry_lookup_failed')
 if(prior)continue
 const {error:ie}=await db.from('site_campaign_contacts').insert({campaign_id:'volte10_20261023',lead_id:lead.id,nome:c.nome,telefone:c.telefone,status:blocked?'blocked':'pending'})
 if(ie)throw Error('registry_insert_failed')
 report.imported++
}
console.log(JSON.stringify({mode:apply?'apply':'preview',...report}))
