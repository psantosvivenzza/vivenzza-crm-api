import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../../package.json',import.meta.url))
const {Router}=require(process.env.EXPRESS_MODULE_PATH || 'express')
const domain=await import('../../src/lib/fretes/domain.js')
const raw=readFileSync(new URL('../../src/routes/fretes.js',import.meta.url),'utf8')
const authRaw=readFileSync(new URL('../../src/middleware/auth.js',import.meta.url),'utf8')
const quote='10000000-0000-4000-8000-000000000001',consult='10000000-0000-4000-8000-000000000002',response='10000000-0000-4000-8000-000000000003'
const actor='10000000-0000-4000-8000-000000000004'
const version='2026-11-02T12:00:00.123456+00:00'
const paths={release:'/:id/consultas/:consultaId/liberar-contato',associate:'/:id/consultas/:consultaId/respostas/:respostaId/associar'}
function setup({ready=false,result,role='admin',token=true,staticKey=false,actorId=actor,linked={id:response,consulta_id:consult},transportError=false}={}){
 const calls=[],logs=[]
 const db={from(table){assert.equal(table,'frete_respostas_pendentes');calls.push({read:table});const q={select(v){assert.equal(v,'id,consulta_id');return q},eq(k,v){assert.equal(k,'id');assert.equal(v,response);return q},async maybeSingle(){return linked?.error?linked:{data:linked,error:null}}};return q},async rpc(name,args){calls.push({name,args});if(transportError)throw Error('fake transport timeout');return result??{data:{id:consult,cotacao_id:quote,ia_pausada:true,contato_liberado:true},error:null}}}
 const ctx={...domain,Router,supabase:db,lerLogisticaNetvision(){},process:{env:{API_SECRET_KEY:'fake-integration-key'}},jwt:{verify(){return {id:actorId,role}}},console:{error(...x){logs.push(x)}}}
 vm.runInNewContext(authRaw.replace(/^import .*$/gm,'').replace(/export /g,'')+'\nglobalThis.authMiddleware=auth;globalThis.adminOuFinanceiro=adminOuFinanceiro',ctx)
 let source=raw.replace(/^import .*$/gm,'').replace('export function createFretesRouter','function createFretesRouter').replace('export default createFretesRouter()','globalThis.factory=createFretesRouter')
 // Only the readiness boundary is fictional in ready=true cases. Production remains closed.
 if(ready)source=source.replace('liberar_contato: false, associar_resposta: false',`liberar_contato: ${ready===true||ready==='release'}, associar_resposta: ${ready===true||ready==='associate'}`)
 vm.runInNewContext(source,ctx)
 const router=ctx.factory(db)
 async function run(action,{body={versao:version,p_actor:'spoofed'},params={}}={}){
  const req={headers:token?{authorization:staticKey?'Bearer fake-integration-key':'Bearer fake-jwt'}:{},body,params:{id:quote,consultaId:consult,respostaId:response,...params}}
  const res={statusCode:200,status(code){this.statusCode=code;return this},json(value){this.body=value;return this}}
  let authenticated=false;ctx.authMiddleware(req,res,()=>{authenticated=true})
  if(!authenticated)return res
  let authorized=false;router.stack.find(x=>!x.route).handle(req,res,()=>{authorized=true})
  if(!authorized)return res
  const layer=router.stack.find(x=>x.route?.path===paths[action]&&x.route.methods.post)
  assert.ok(layer,'Real router must register action')
  await layer.route.stack.at(-1).handle(req,res)
  return res
 }
 return {run,calls,logs}
}
for(const action of ['release','associate']){
 test(`${action}: production readiness false blocks before RPC`,async()=>{const s=setup();assert.equal((await s.run(action)).statusCode,409);assert.equal(s.calls.length,0)})
 test(`${action}: missing authentication blocks before RPC`,async()=>{const s=setup({ready:true,token:false});assert.equal((await s.run(action)).statusCode,401);assert.equal(s.calls.length,0)})
 test(`${action}: seller cannot operate`,async()=>{const s=setup({ready:true,role:'vendedor'});assert.equal((await s.run(action)).statusCode,403);assert.equal(s.calls.length,0)})
 test(`${action}: version required and parseable`,async()=>{for(const body of [{},{versao:null},{versao:'invalid'},{versao:'2026'},{versao:'Nov 2'},{versao:'2026-11-02T12:00:00'},{versao:'2026-02-31T12:00:00Z'}]){const s=setup({ready:true});assert.equal((await s.run(action,{body})).statusCode,409);assert.equal(s.calls.length,0)}})
 test(`${action}: bad identifiers never reach RPC`,async()=>{for(const key of action==='release'?['id','consultaId']:['id','consultaId','respostaId']){const s=setup({ready:true});assert.equal((await s.run(action,{params:{[key]:'invalid'}})).statusCode,400);assert.equal(s.calls.length,0)}})
 test(`${action}: finance success uses authenticated actor and exactly one RPC`,async()=>{const s=setup({ready:true,role:'financeiro'});assert.equal((await s.run(action)).statusCode,200);assert.equal(s.calls.filter(x=>x.name).length,1);assert.equal(s.calls.filter(x=>x.read).length,action==='associate'?1:0);assert.equal(s.calls[0].name,action==='release'?'frete_liberar_contato':'frete_associar_resposta');assert.deepEqual(JSON.parse(JSON.stringify(s.calls[0].args)),{p_cotacao_id:quote,p_consulta_id:consult,...(action==='associate'?{p_resposta_id:response}:{}),p_versao:version,p_actor:actor})})
 test(`${action}: SQL conflict stays conflict without retry`,async()=>{const s=setup({ready:true,result:{error:{code:'P0001',message:'Atendimento alterado.'},data:null}});assert.equal((await s.run(action)).statusCode,409);assert.equal(s.calls.length,1)})
 test(`${action}: error plus plausible receipt never succeeds`,async()=>{const s=setup({ready:true,result:{error:{code:'08006'},data:{id:consult,cotacao_id:quote,ia_pausada:true,contato_liberado:true}}});assert.equal((await s.run(action)).statusCode,503);assert.equal(s.calls.length,1)})
 test(`${action}: malformed receipt stays unconfirmed without retry`,async()=>{for(const data of [null,[],{}, {id:quote,cotacao_id:quote,ia_pausada:true}, {id:consult,cotacao_id:quote,ia_pausada:false},...(action==='release'?[{id:consult,cotacao_id:quote,ia_pausada:true,contato_liberado:false}]:[])]){const s=setup({ready:true,result:{data,error:null}});const res=await s.run(action);assert.equal(res.statusCode,503);assert.match(res.body.erro,/pode ter sido concluída/);assert.equal(s.calls.length,1)}})
}

for(const action of ['release','associate']){
 test(`${action}: static integration credential cannot perform human action`,async()=>{const s=setup({ready:true,staticKey:true});assert.equal((await s.run(action)).statusCode,403);assert.equal(s.calls.length,0)})
 test(`${action}: JWT without UUID actor cannot operate`,async()=>{const s=setup({ready:true,actorId:'fake-actor'});assert.equal((await s.run(action)).statusCode,403);assert.equal(s.calls.length,0)})
 test(`${action}: independent readiness cannot authorize the other action`,async()=>{const s=setup({ready:action==='release'?'associate':'release'});assert.equal((await s.run(action)).statusCode,409);assert.equal(s.calls.length,0)})
 test(`${action}: transport timeout is unconfirmed, no write retry`,async()=>{const s=setup({ready:true,transportError:true});const res=await s.run(action);assert.equal(res.statusCode,503);assert.match(res.body.erro,/pode ter sido concluída/);assert.equal(s.calls.length,1);assert.deepEqual(s.logs,[['[fretes] CONTACT_OPERATION_UNCONFIRMED']])})
}
test('associate: exact response readback required, never repeats RPC',async()=>{
 for(const linked of [null,{}, {id:quote,consulta_id:consult},{id:response,consulta_id:quote},{error:{code:'08006'},data:null}]){
  const s=setup({ready:true,linked});const res=await s.run('associate');assert.equal(res.statusCode,503);assert.match(res.body.erro,/pode ter sido concluída/);assert.equal(s.calls.filter(x=>x.name).length,1);assert.equal(s.calls.filter(x=>x.read).length,1)
 }
})
