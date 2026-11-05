import {supabase} from '../supabase-admin.server.js'
import {paraJidWhatsapp,candidatosTelefone} from '../telefone.js'
export async function financialHumanPause(phone,{db=supabase}={}) {
 const canonical=typeof phone==='string'?paraJidWhatsapp(phone):''
 if(!/^55\d{10,11}$/.test(canonical))return {blocked:true,reason:'phone_not_confirmed'}
 const variants=[...new Set(candidatosTelefone(canonical).filter(n=>/^55\d{10,11}$/.test(n)))]
 let r
 try{r=await db.from('financial_ai_contacts').select('human').in('phone',variants).limit(6).abortSignal(AbortSignal.timeout(10000))}
 catch{return {blocked:true,reason:'human_state_unavailable'}}
 if(!r||r.error||!Array.isArray(r.data)||r.data.some(row=>typeof row?.human!=='boolean'))return {blocked:true,reason:'human_state_unavailable'}
 const blocked=r.data.some(row=>row.human===true)
 return {blocked,reason:blocked?'financial_human_takeover':null}
}
