import test from 'node:test'
import assert from 'node:assert/strict'
import {landingIdentity,landingConsent,enqueueLandingLara,createLandingLaraWorker,stopLandingLara} from '../../src/lib/landingLara.js'
import {createPublicLandingLeadHandler} from '../../src/lib/publicLandingLead.js'

// In-memory PostgREST boundary. No credentials, network, or real recipients.
function database(){
 const tables={leads:[],contatos:[],whatsapp_mensagens:[],sdr_conversas:[],automacoes_config:[{id:1,sdr_ativo:true}],
  whatsapp_connections:[{id:'comercial',instance_name:'vivenzza',owner:'fzap',finalidade:'comercial'}]}
 let seq=0
 const db={tables,fail:null,from(table){
  let op='select',payload,filters=[],single=false,opts={},limit=Infinity,sort
  const field=(r,k)=>k.includes('->>')?r[k.split('->>')[0]]?.[k.split('->>')[1]]:r[k]
  const q={select(_s,o){opts=o||{};return q},insert(p){op='insert';payload=p;return q},update(p){op='update';payload=p;return q},
   eq(k,v){filters.push(r=>field(r,k)===v);return q},neq(k,v){filters.push(r=>field(r,k)!==v);return q},
   in(k,v){filters.push(r=>v.includes(field(r,k)));return q},is(k,v){filters.push(r=>(field(r,k)??null)===v);return q},
   gte(k,v){filters.push(r=>field(r,k)>=v);return q},lt(k,v){filters.push(r=>field(r,k)<v);return q},
   or(){filters.push(r=>r.atendimento_humano===true||r.whatsapp_opt_out===true||r.ativo===false);return q},
   order(k){sort=k;return q},limit(n){limit=n;return q},single(){single=true;return q},maybeSingle(){single=true;return q},abortSignal(){return q},
   then(resolve,reject){return Promise.resolve().then(()=>{
    if(db.fail===table)return {data:null,error:{code:'unavailable'}}
    let rows=tables[table].filter(r=>filters.every(f=>f(r)))
    if(sort)rows.sort((a,b)=>String(a[sort]).localeCompare(String(b[sort])))
    rows=rows.slice(0,limit)
    if(op==='insert'){
     if(tables[table].some(r=>payload.id&&r.id===payload.id||payload.evolution_id&&r.evolution_id===payload.evolution_id||table==='sdr_conversas'&&r.telefone===payload.telefone))return {data:null,error:{code:'23505'}}
     rows=[{id:++seq,created_at:new Date().toISOString(),criado_em:new Date().toISOString(),...structuredClone(payload)}];tables[table].push(...rows)
    }
    if(op==='update')for(const r of rows)Object.assign(r,structuredClone(payload))
    return {data:opts.head?null:single?(rows[0]||null):structuredClone(rows),count:rows.length,error:null}
   }).then(resolve,reject)}
  };return q
 }};return db
}
const phone='51999990001',identity=landingIdentity(phone)
async function fixture(){const db=database();const lead={id:identity.leadId,nome:'Pessoa Teste',telefone:phone,responsavel_id:'seller',ativo:true};db.tables.leads.push(lead);await enqueueLandingLara({db,lead,identity,interest:'Distribuidor'});return db}
function provider(hook){const calls=[];return {calls,async get(){return {data:{instance:{state:'open'}}}},async post(url,b){calls.push({url,b});if(hook)await hook(url,b);if(url.includes('whatsappNumbers'))return {data:[{exists:true,jid:identity.jid+'@s.whatsapp.net'}]};return {data:{key:{id:b.clientMessageId}}}}}}
test('aliases converge; invalid phones and unapproved source cannot opt in',()=>{
 assert.equal(identity.messageId,landingIdentity('+55 '+phone).messageId)
 assert.equal(identity.messageId,landingIdentity('5199990001').messageId)
 assert.throws(()=>landingIdentity('123'))
 assert.equal(landingConsent({whatsapp_consent:true,event_source_url:'https://distribuidores.vivenzzaprofessional.com.br/'},'https://evil.example'),false)
})
test('concurrent duplicate submissions reserve just one message',async()=>{
 const db=await fixture();await Promise.all(Array.from({length:8},()=>enqueueLandingLara({db,lead:db.tables.leads[0],identity,interest:'Distribuidor'})))
 assert.equal(db.tables.whatsapp_mensagens.length,1)
 const api=provider();const worker=createLandingLaraWorker({db,api});await Promise.all([worker(),worker(),createLandingLaraWorker({db,api})()])
 assert.equal(api.calls.filter(c=>c.url.includes('sendText')).length,1)
 assert.equal(db.tables.sdr_conversas[0].status_atendimento,'ia_atendendo')
 assert.match(db.tables.sdr_conversas[0].historico[0].content,/já atende salões/)
})
for(const flag of ['atendimento_humano','whatsapp_opt_out','inactive'])test('blocks '+flag,async()=>{
 const db=await fixture();db.tables.leads[0][flag==='inactive'?'ativo':flag]=flag!=='inactive'
 const api=provider();await createLandingLaraWorker({db,api})();assert.equal(api.calls.length,0)
})
test('human takeover during lookup blocks first send',async()=>{
 const db=await fixture();const api=provider(async()=>{db.tables.leads[0].atendimento_humano=true})
 await createLandingLaraWorker({db,api})();assert.equal(api.calls.filter(c=>c.url.includes('sendText')).length,0)
})
test('prior conversation or reply cancels opening',async()=>{
 const db=await fixture();db.tables.sdr_conversas.push({telefone:identity.jid,status_atendimento:'ia_atendendo'})
 const api=provider();await createLandingLaraWorker({db,api})();assert.equal(api.calls.length,0)
})
test('timeout after send is quarantined and never repeated',async()=>{
 const db=await fixture();const api=provider(async url=>{if(url.includes('sendText'))throw Error('timeout')})
 const worker=createLandingLaraWorker({db,api});assert.equal((await worker()).status,'uncertain');await worker()
 assert.equal(db.tables.whatsapp_mensagens[0].status,'incerto');assert.equal(api.calls.filter(c=>c.url.includes('sendText')).length,1)
})
test('lookup timeout recovers before send; database outage never sends',async()=>{
 const db=await fixture();let fail=true;const api=provider(async url=>{if(fail&&url.includes('whatsappNumbers'))throw Error('timeout')})
 const worker=createLandingLaraWorker({db,api});assert.equal((await worker()).status,'deferred');fail=false;assert.equal((await worker()).status,'sent')
 const db2=await fixture();db2.fail='leads';const api2=provider();await createLandingLaraWorker({db:db2,api:api2})();assert.equal(api2.calls.length,0)
})
test('receipt arriving before HTTP completion is not downgraded',async()=>{
 const db=await fixture();const api=provider(async url=>{if(url.includes('sendText'))db.tables.whatsapp_mensagens[0].status='entregue'})
 await createLandingLaraWorker({db,api})();assert.equal(db.tables.whatsapp_mensagens[0].status,'entregue')
})
test('disabled Lara and existing commercial traffic defer',async()=>{
 const db=await fixture();db.tables.automacoes_config[0].sdr_ativo=false;const api=provider();assert.equal((await createLandingLaraWorker({db,api})()).status,'disabled')
 db.tables.automacoes_config[0].sdr_ativo=true;for(let i=0;i<15;i++)db.tables.whatsapp_mensagens.push({id:'prior'+i,instance_name:'vivenzza',direcao:'saida',status:'entregue',created_at:new Date().toISOString()})
 assert.equal((await createLandingLaraWorker({db,api})()).status,'paced');assert.equal(api.calls.length,0)
})
test('STOP cancels pending opening and prevents future contact',async()=>{
 const db=await fixture();await stopLandingLara({db,phone:identity.jid});assert.equal(db.tables.leads[0].whatsapp_opt_out,true)
 const api=provider();await createLandingLaraWorker({db,api})();assert.equal(api.calls.length,0)
})
test('expired queue cannot send and crash before dispatch may recover',async()=>{
 const db=await fixture();db.tables.whatsapp_mensagens[0].media_data.submitted_at=new Date(Date.now()-25*3600000).toISOString()
 const api=provider();assert.equal((await createLandingLaraWorker({db,api})()).status,'expired');assert.equal(api.calls.length,0)
 const db2=await fixture();Object.assign(db2.tables.whatsapp_mensagens[0],{status:'processando'});db2.tables.whatsapp_mensagens[0].media_data.claimed_at=new Date(Date.now()-16*60000).toISOString()
 assert.equal((await createLandingLaraWorker({db:db2,api:provider()})()).status,'sent')
})
test('crash after dispatch never requeues',async()=>{
 const db=await fixture();Object.assign(db.tables.whatsapp_mensagens[0],{status:'processando',created_at:new Date(Date.now()-16*60000).toISOString()});db.tables.whatsapp_mensagens[0].media_data.phase='dispatching'
 const api=provider();assert.equal((await createLandingLaraWorker({db,api})()).status,'uncertain');assert.equal(api.calls.length,0)
})
test('real route handler: retry and country-code aliases preserve one CRM lead, one queue intent, one seller',async()=>{
 const db=database();let sellers=0;const handler=createPublicLandingLeadHandler({db,nextSeller:async()=>{sellers++;return{id:'seller'}},capi:async()=>{}})
 const req={headers:{origin:'https://distribuidores.vivenzzaprofessional.com.br'},body:{nome:'Pessoa Teste',telefone:phone,interesse:'Distribuidor',whatsapp_consent:true,event_source_url:'https://distribuidores.vivenzzaprofessional.com.br/'}}
 const response=()=>({status(n){this.code=n;return this},json(body){this.body=body;return this}})
 const r=response();await handler(req,r);assert.equal(r.code,201)
 await handler({...req,body:{...req.body,telefone:'+55'+phone}},response())
 assert.equal(db.tables.leads.length,1);assert.equal(db.tables.contatos.length,1);assert.equal(db.tables.whatsapp_mensagens.length,1);assert.equal(sellers,1)
 const api=provider();await createLandingLaraWorker({db,api})();assert.equal(api.calls.filter(c=>c.url.includes('sendText')).length,1)
})
test('legacy form without opt-in still saves CRM but cannot send',async()=>{
 const db=database();const handler=createPublicLandingLeadHandler({db,nextSeller:async()=>({id:'seller'}),capi:async()=>{}})
 await handler({headers:{},body:{nome:'Pessoa Teste',telefone:phone}},{status(){return this},json(){}})
 assert.equal(db.tables.leads.length,1);assert.equal(db.tables.whatsapp_mensagens.length,0)
})
