import fs from 'node:fs/promises'
import {createClient} from '@supabase/supabase-js'
import {importSiteAudience,SITE_AUDIENCE_ID} from '../src/lib/siteCampaignAudienceImport.js'
const file=process.argv.find(v=>v.startsWith('--file='))?.slice(7)
if(!file)throw Error('missing_input_file')
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
async function pages(table,fields,filter){const rows=[];for(let offset=0;;offset+=1000){let q=db.from(table).select(fields);if(filter)q=q.eq('campaign_id',SITE_AUDIENCE_ID);const {data,error}=await q.order('id').range(offset,offset+999);if(error)throw Error('audience_lookup_failed');rows.push(...data);if(data.length<1000)return rows}}
async function insert(table,values){const {data,error}=await db.from(table).insert(values).select('*').single();if(error)throw Error('audience_insert_failed');return data}
const repo={
 async config(){const {data,error}=await db.from('site_campaign_config').select('enabled').eq('id',SITE_AUDIENCE_ID).single();if(error)throw Error('campaign_config_unavailable');return data},
 leads:()=>pages('leads','id,telefone,whatsapp_opt_out,atendimento_humano,ativo',false),
 async suppressedPhones(){const {data,error}=await db.rpc('site_campaign_suppressed_phones');if(error)throw Error('audience_suppression_lookup_failed');return data||[]},
 recipients:()=>pages('site_campaign_contacts','id,lead_id,telefone,status',true),
 async blockRecipients(ids){const {error}=await db.from('site_campaign_contacts').update({status:'blocked',last_error:'nuvemshop_marketing_declined_or_crm_blocked'}).in('id',ids).in('status',['pending','reserved']);if(error)throw Error('audience_block_failed')},
 insertLead:values=>insert('leads',values),insertRecipient:values=>insert('site_campaign_contacts',values),
}
console.log(JSON.stringify(await importSiteAudience({repo,contacts:JSON.parse(await fs.readFile(file,'utf8')),apply:process.argv.includes('--apply')})))
