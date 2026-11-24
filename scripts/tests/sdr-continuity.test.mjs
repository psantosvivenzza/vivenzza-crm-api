import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {AsyncLocalStorage} from 'node:async_hooks'
import * as continuity from '../../src/lib/sdrContinuity.js'
import * as telephone from '../../src/lib/telefone.js'
import * as ownership from '../../src/lib/sdrOwnership.js'
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}

test('landing assistant-only opening and truncated history preserve the last question',()=>{
 const h=[{role:'assistant',content:'Sou a Lara. Você já atende salões?'}]
 const result=continuity.prepareSdrTurn(h,'Sim, já atendo','texto')
 assert.equal(result.continuing,true);assert.equal(result.messages[0].role,'user')
 assert.equal(result.messages[1].content,h[0].content);assert.equal(result.recent.length,2)
 assert.equal(h.length,1);assert.match(continuity.sdrContinuityInstructions(true),/Não se apresente novamente/)
 assert.equal(continuity.sdrContinuityInstructions(false),'')
 const long=Array.from({length:30},(_,i)=>({role:i%2?'user':'assistant',content:String(i)}))
 assert.ok(continuity.prepareSdrTurn(long,'agora','texto').messages.some(x=>x.content.includes('28')))
})
test('FIFO survives failure, aliases share key, channels stay independent',async()=>{
 const run=continuity.createSdrTurnQueue(),g=gate(),events=[]
 const k=continuity.sdrTurnKey('vivenzza','sdr_conversas',{key:{remoteJid:'5511999990000@s.whatsapp.net'}})
 assert.equal(k,continuity.sdrTurnKey('vivenzza','sdr_conversas',{key:{remoteJid:'123@lid',remoteJidAlt:'551199990000@s.whatsapp.net'}}))
 assert.equal(continuity.sdrTurnKey('vivenzza','sdr_conversas',{key:{remoteJid:'123@lid'}}),null)
 const first=run(k,async()=>{events.push(1);await g.promise;throw Error('fixture')});first.catch(()=>{})
 const second=run(k,async()=>events.push(2));await run('other',async()=>events.push(3))
 assert.deepEqual(events,[1,3]);g.resolve();await assert.rejects(first);await second;assert.deepEqual(events,[1,3,2])
})
async function fixture({modelElapsed=5000,newContact=false}={}){
 const pause=gate(),entered=gate(),calls=[],sends=[];let human=false,clock=Date.now(),conv={telefone:'5511999990000',estado:'qualificando',tipo_lead:'distribuidor',status_atendimento:'ia_atendendo',historico:[{role:'assistant',content:'Sou a Lara. Você já atende salões?',timestamp:new Date(clock-10000).toISOString()}]}
 class TestDate extends Date {constructor(...a){super(...(a.length?a:[clock]))}static now(){return clock}}
 if(newContact)conv=null
 const db={from(table){let op='select',payload,filters={},single=false;const q={};for(const m of ['select','eq','neq','in','or','order','limit','maybeSingle','single','upsert','insert','update','is','gte'])q[m]=(...a)=>{if(['upsert','insert','update'].includes(m)){op=m;payload=a[0]}if(m==='eq')filters[a[0]]=a[1];if(['single','maybeSingle'].includes(m))single=true;return q};q.abortSignal=async()=>{
 let data=[]
 if(table==='automacoes_config')data={sdr_ativo:true,voz_ativa:false}
 if(table==='sdr_conversas'){
  if(op!=='select'){if(!human){conv={...conv,...payload};data=[{telefone:conv.telefone}]}}
  else data=filters.status_atendimento==='vendedor_assumiu'?(human?[{telefone:conv.telefone}]:[]):conv?[{...conv,historico:structuredClone(conv.historico)}]:[]
 }
 if(table==='leads')data=human?[{id:'owned'}]:[]
 if(single&&Array.isArray(data))data=data[0]||null
 return {data,error:null,count:0}
 };return q}}
 class AI {messages={create:async(body)=>{calls.push(body);clock+=modelElapsed;if(calls.length===1){entered.resolve();await pause.promise}return {content:[{text:JSON.stringify({resposta:calls.length===1?'Em qual cidade você atua?':'Quantos salões você atende hoje?',acao:'NENHUMA',tipo_lead:'consumidor_final',proximo_estado:'qualificando',etapa_cadencia:2})}]}}}}
 const router={get(){},post(){}}
 const client={post:async(path,body)=>{sends.push({path,body});return {data:{key:{id:'out-'+sends.length}}}}}
 const deps={
 '../lib/sdrContinuity.js':continuity,'../lib/sdrOwnership.js':ownership,'express':{Router:()=>router},'axios':{default:{}},'@anthropic-ai/sdk':{default:AI},'node:crypto':{randomUUID:()=> 'opaque'},'node:async_hooks':{AsyncLocalStorage},
 '../lib/whatsappProviderClient.js':{createWhatsappProviderClient:()=>client},'../lib/siteCampaignPolicy.js':{siteCampaignContext:()=>null,siteCampaignInstructions:()=>'',isStopRequest:()=>false,enforceSiteCampaignReply:x=>x},'../lib/landingLara.js':{stopLandingLara:async()=>false},'../lib/siteCampaignReceipts.js':{applySiteCampaignReceipts:async()=>{}},'../lib/supabase-admin.server.js':{supabase:db},'./webhook-handler.js':{processWhatsappEvent:async()=>({inserted:true})},'../lib/telefone.js':telephone,'../middleware/auth.js':{auth(){}},'../middleware/webhookAuth.js':{webhookAuth(){}},'../lib/whatsappInboundOwnership.js':{evolutionOwnership(){}},'../lib/catalogos.js':{CATALOGO_PROFISSIONAL:'',CATALOGO_COLORACAO:'',CATALOGO_HOME_CARE:''},'../lib/qualificacaoLead.js':{avaliarLead:()=>null,cnpjValido:()=>false,soDigitos:()=>''},'../lib/qualificacaoLookup.js':{situacaoCnpj:async()=>null,inadimplenteNoErp:async()=>false,carregarTerritorio:async()=>null},'../lib/sdrConversas.js':{marcarVendedorAssumiu:async()=>{}}
 }
 const context=vm.createContext({console:{log(){},warn(){},error(){}},process:{env:{EVOLUTION_INSTANCE:'vivenzza'}},Date:TestDate,AbortSignal,setTimeout,setInterval(){}})
 const mod=new vm.SourceTextModule(await readFile(new URL('../../src/routes/sdr.js',import.meta.url),'utf8'),{context})
 await mod.link(id=>{assert.ok(deps[id],id);const obj=deps[id];return new vm.SyntheticModule(Object.keys(obj),function(){for(const [k,v]of Object.entries(obj))this.setExport(k,v)},{context})});await mod.evaluate()
 const send=(id,text)=>mod.namespace.handleFzapSdrWebhook({body:{event:'messages.upsert',instance:'vivenzza',data:{key:{id,fromMe:false,remoteJid:'5511999990000@s.whatsapp.net'},message:{conversation:text}}}},{json(){},status(){return this}})
 return {send,calls,sends,entered,pause,takeover(){human=true;conv.status_atendimento='vendedor_assumiu'},history:()=>conv.historico}
}
test('real webhook serializes overlapping messages and second model request sees first answer',async()=>{
 const f=await fixture({modelElapsed:0}),a=f.send('in1','Sim, já tenho clientes');await f.entered.promise
 const b=f.send('in2','Atendo na minha cidade');await new Promise(r=>setImmediate(r));assert.equal(f.calls.length,1)
 f.pause.resolve();await Promise.all([a,b]);assert.equal(f.sends.length,2);assert.equal(f.calls.length,2)
 assert.equal(f.calls[0].output_config.format.type,'json_schema')
 assert.ok(f.calls[1].messages.some(m=>m.role==='assistant'&&m.content.includes('Em qual cidade')))
 assert.match(f.calls[0].system,/CONTINUIDADE OBRIGATÓRIA/);assert.match(f.calls[1].system,/CONTINUIDADE OBRIGATÓRIA/)
 assert.equal(f.history().filter(x=>x.role==='user').length,2)
})
test('human takeover while model pending suppresses both in-flight and queued replies',async()=>{
 const f=await fixture(),a=f.send('in1','Quero conhecer as condições');await f.entered.promise
 const b=f.send('in2','Pode me ajudar?');f.takeover();f.pause.resolve();await Promise.all([a,b]);assert.equal(f.sends.length,0);assert.equal(f.calls.length,1)
})


test('non-model history is preserved for CRM; model roles remain valid',()=>{
 const history=[{role:'operator',content:{media:'fixture'}},{role:'assistant',content:'Qual cidade?'},{role:'user',content:'Cidade A'}]
 const result=continuity.prepareSdrTurn(history,'Atendo 20 salões','texto')
 assert.deepEqual(result.recent[0],history[0]);assert.ok(result.messages.every(m=>['user','assistant'].includes(m.role)&&typeof m.content==='string'))
})

test('new lead with two near-simultaneous inputs saves first turn before the second, without insert race or silent drop',async()=>{
 const f=await fixture({newContact:true,modelElapsed:0}),a=f.send('new1','Quero conhecer a parceria');await f.entered.promise
 const b=f.send('new2','Bom dia');f.pause.resolve();await Promise.all([a,b])
 assert.equal(f.calls.length,2);assert.equal(f.sends.length,2)
 assert.equal(f.history().filter(h=>h.role==='user').length,2)
 assert.equal(f.history().filter(h=>h.role==='assistant').length,2)
 assert.ok(!f.calls[0].system.includes('CONTINUIDADE OBRIGATÓRIA'))
 assert.ok(f.calls[1].system.includes('CONTINUIDADE OBRIGATÓRIA'))
})

