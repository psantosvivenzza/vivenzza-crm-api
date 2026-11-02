import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
const id='11111111-1111-4111-8111-111111111111', request='22222222-2222-4222-8222-222222222222'
async function fixture(o={}){
 const routes=new Map(),writes=[],sends=[];let claimed=false,status=null
 const router={use(fn){routes.set('auth',fn)},get(p,fn){routes.set('GET '+p,fn)},patch(p,fn){routes.set('PATCH '+p,fn)},post(p,fn){routes.set('POST '+p,fn)}}
 const db={rpc(){return query('rpc')},from(t){return query(t)}}
 function query(t){let op='select',val;const q={};for(const m of ['select','eq','in','order','limit','single','maybeSingle','insert','update'])q[m]=(...args)=>{if(['insert','update'].includes(m)){op=m;val=args[0];writes.push([t,m,val])}return q};q.abortSignal=async()=>{
 let data=null,error=null
 if(t==='financial_ai_contacts')data={id,phone:'5511999990000',instance_name:'financeiro',human:true,updated_at:'2026-10-30T12:00:00Z'}
 if(t==='financial_ai_runs'&&o.pendingAI)data={id:'pending'}
 if(t==='whatsapp_instances')data={role:'principal',enabled:!o.disabled}
 if(t==='financial_manual_sends'){
  if(op==='insert'){if(claimed)error={code:'23505'};else{claimed=true;status='reserved';data={id:request}}}
  else if(op==='update'){status=val.status;data={id:request}}
  else if(o.pendingManual||['reserved','uncertain'].includes(status))data={id:request,status}
 }
 if(t==='rpc')data='budget'
 return{data,error}
 };return q}
 const deps={express:{Router:()=>router},'../lib/supabase-admin.server.js':{supabase:db},'../lib/whatsappProviderClient.js':{createWhatsappProviderClient:()=>({get:async()=>({data:{instance:{state:'open'}}}),post:async()=>{sends.push(1);if(o.timeout)throw Error('timeout');return{data:{key:{id:'provider'}}}}}),whatsappTransportFor:async()=> 'fzap'},'../lib/collection/doNotContactGuard.js':{estaEmDoNotContact:async()=>({blocked:!!o.dnc})},'../lib/collection/collectionContactPolicy.js':{dentroDaJanela:()=>true}}
 const context=vm.createContext({console,AbortSignal,Date});const mod=new vm.SourceTextModule(await readFile(new URL('../../src/routes/financial-inbox.js',import.meta.url),'utf8'),{context});await mod.link(k=>new vm.SyntheticModule(Object.keys(deps[k]),function(){for(const [n,v]of Object.entries(deps[k]))this.setExport(n,v)},{context}));await mod.evaluate()
 async function call(key,body={},user={id,role:'financeiro'}){let code=200,data;const res={set(){},status(n){code=n;return this},json(d){data=d;return this}};let allowed=false;routes.get('auth')({user},res,()=>allowed=true);if(allowed)await routes.get(key)({params:{id},body,user},res);return{code,data}}
 return{call,writes,sends}
}
test('caixa financeira nega vendedor, ausência de usuário e integração sem usuário humano',async()=>{const f=await fixture();for(const user of [{id,role:'vendedor'},{id:'api-user',role:'admin'},{}])assert.equal((await f.call('GET /',{},user)).code,403);assert.equal(f.writes.length,0)})
test('retomada nunca libera resultados pendentes de IA ou envio manual',async()=>{for(const o of [{pendingAI:true},{pendingManual:true}]){const f=await fixture(o);assert.equal((await f.call('PATCH /:id/humano',{humano:false,esperado:true,versao:'2026-10-30T12:00:00Z'})).code,409);assert.equal(f.writes.length,0)}})
test('DNC e canal desabilitado impedem POST ao provedor',async()=>{for(const o of [{dnc:true},{disabled:true}]){const f=await fixture(o);assert.equal((await f.call('POST /:id/enviar',{request_id:request,texto:'Fictício'})).code,409);assert.equal(f.sends.length,0)}})
test('timeout manual fica incerto; repetir pedido não reenvia',async()=>{const f=await fixture({timeout:true});const body={request_id:request,texto:'Fictício'};assert.equal((await f.call('POST /:id/enviar',body)).code,502);assert.equal((await f.call('POST /:id/enviar',body)).code,409);assert.equal(f.sends.length,1);assert.ok(f.writes.some(x=>x[2].status==='uncertain'))})
test('envio aceito assume atendimento; UUID repetido não faz segundo POST',async()=>{const f=await fixture();const body={request_id:request,texto:'Fictício'};assert.equal((await f.call('POST /:id/enviar',body)).code,200);assert.equal((await f.call('POST /:id/enviar',body)).code,409);assert.equal(f.sends.length,1);assert.ok(f.writes.some(x=>x[0]==='financial_ai_contacts'&&x[2].human===true))})
