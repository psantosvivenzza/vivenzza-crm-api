import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {createFinancialInboundProcessor} from '../../src/lib/financialAiPolicy.js'
async function fixture(o={}){
 const sends=[],writes=[];const now=Date.now();const row={id:'msg',telefone:'5511999990000',mensagem:'quero pix',instance_name:'financeiro',direcao:'entrada',media_tipo:o.media?'audio':null,created_at:new Date(now-1000).toISOString()}
 const config={financial_ai_enabled:true,financial_ai_enabled_at:new Date(now-60000).toISOString(),cobranca_whatsapp_ativa:true,...o.config}
 const db={rpc(){return query('rpc')},from(t){return query(t)}}
 function query(t){let op='select',filters={};const q={};for(const m of ['select','eq','neq','in','gte','lte','order','limit','single','maybeSingle','upsert','insert','update'])q[m]=(...a)=>{if(['upsert','insert','update'].includes(m)){op=m;writes.push([t,m,a[0]])}if(m==='eq')filters[a[0]]=a[1];return q};q.abortSignal=async()=>{
 let data=null,count=0
 if(t==='automacoes_config')data=config
 if(t==='whatsapp_mensagens')data=filters.evolution_id?row:filters.direcao==='saida'?(o.outbound?{evolution_id:'unknown',mensagem:'operator',created_at:row.created_at}:null):{id:o.newer?'other':'msg',direcao:'entrada'}
 if(t==='financial_ai_contacts')data={id:'contact',instance_name:'financeiro',human:!!o.human,reason:null,updated_at:row.created_at}
 if(t==='financial_ai_runs'){if(op!=='select')data={id:'run'};else if(filters.provider_message_id)data=null;else if(o.unfinished)data={id:'other'};count=o.cap?3:0}
 if(t==='whatsapp_instances')data={role:o.role||'principal',enabled:o.enabled!==false}
 if(t==='cobrancas_whatsapp')data=[]
 if(t==='rpc')data='reservation'
 return{data,count,error:null}
 };return q}
 const client={get:async()=>({data:{instance:{state:o.disconnected?'close':'open'}}}),post:async(...a)=>{sends.push(a);return{data:{key:{id:'provider'}}}}}
 class AI{messages={create:async()=>({content:[{type:'text',text:'{}'}]})}}
 const deps={
 '@anthropic-ai/sdk':{default:AI},'./supabase-admin.server.js':{supabase:db},'./whatsappProviderClient.js':{createWhatsappProviderClient:()=>client,whatsappTransportFor:async()=>o.owner||'fzap'},
 './collection/financialSyncGuard.js':{verificarFrescorSync:async()=>({allowed:!o.stale})},'./collection/doNotContactGuard.js':{estaEmDoNotContact:async()=>({blocked:!!o.dnc})},'./collection/collectionContactPolicy.js':{dentroDaJanela:()=>!o.outside},
 './telefone.js':{telefonesEquivalentes:(a,b)=>a===b},'./siteCampaignPolicy.js':{isStopRequest:()=>!!o.stop},'./collection/ai/intentClassifier.js':{CLASSIFY_SYSTEM_PROMPT:'fixture',validarClassificacao:()=>({intent:'QUERO_PAGAR',confidence:'alta',clienteIrritado:false})},'./financialAiPolicy.js':{createFinancialInboundProcessor}
 }
 const context=vm.createContext({console,process:{env:{CHAVE_PIX_VIVENZZA:'00000000000000'}},AbortSignal,Date,setTimeout})
 const mod=new vm.SourceTextModule(await readFile(new URL('../../src/lib/financialAiRuntime.js',import.meta.url),'utf8'),{context})
 await mod.link(id=>{assert.ok(deps[id],id);const obj=deps[id];return new vm.SyntheticModule(Object.keys(obj),function(){for(const [k,v]of Object.entries(obj))this.setExport(k,v)},{context})});await mod.evaluate()
 return{sends,writes,run:()=>mod.namespace.processFinancialInbound({id:'event',timestamp:Math.floor(now/1000)})}
}
test('handler real usa contratos principal e reserva, mantendo resposta no canal de entrada',async()=>{for(const role of ['principal','reserva']){const f=await fixture({role});assert.equal((await f.run()).status,'sent');assert.equal(f.sends.length,1);assert.match(f.sends[0][0],/financeiro$/)}})
test('handler real não envia com estado, canal, humano ou fonte não confirmados',async()=>{for(const o of [{role:'commercial'},{enabled:false},{owner:'evolution'},{human:true},{stale:true},{dnc:true},{newer:true},{outbound:true},{cap:true},{outside:true},{disconnected:true},{config:{financial_ai_enabled:false}}]){const f=await fixture(o);await f.run();assert.equal(f.sends.length,0,JSON.stringify(o))}})
test('recusa persiste DNC mesmo com IA desligada, sem envio',async()=>{const f=await fixture({stop:true,config:{financial_ai_enabled:false}});await f.run();assert.equal(f.sends.length,0);assert.ok(f.writes.some(x=>x[0]==='collection_do_not_contact'&&x[1]==='upsert'))})

test('anexo cria fila antes de assumir, sem resposta automatica',async()=>{const f=await fixture({media:true});await f.run();const creates=f.writes.findIndex(x=>x[0]==='financial_ai_contacts'&&x[1]==='upsert');const pauses=f.writes.findIndex(x=>x[0]==='financial_ai_contacts'&&x[1]==='update');assert.ok(creates>=0&&pauses>creates);assert.equal(f.sends.length,0)})

test('fora do horario bloqueia sem assumir atendimento humano',async()=>{const f=await fixture({outside:true});assert.equal((await f.run()).status,'blocked');assert.equal(f.writes.some(x=>x[0]==='financial_ai_contacts'&&x[1]==='update'&&x[2]?.human===true),false);assert.equal(f.sends.length,0)})
