import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import express from 'express'

const actor='11111111-1111-4111-8111-111111111111'
const contactId='22222222-2222-4222-8222-222222222222'
const version='2026-10-30T12:00:00Z'
const prefix='/api/financeiro-atendimentos'
async function fixture(options={}) {
 const queries=[],writes=[],provider=[],verified=[]
 const contact={id:contactId,phone:'5511000000000',instance_name:'fixture-financial',human:true,updated_at:version}
 const db={from:table=>query(table),rpc:(...args)=>{throw Error('UNEXPECTED_BUDGET_RPC')}}
 function query(table){
  let op='select',value,projection;const filters=[];const q={}
  for(const method of ['select','eq','in','order','limit','single','maybeSingle','insert','update'])q[method]=(...args)=>{
   if(method==='select')projection=args[0]
   if(['insert','update'].includes(method)){op=method;value=args[0]}
   if(['eq','in'].includes(method))filters.push([method,...args])
   return q
  }
  q.abortSignal=async()=>{
   const entry={table,op,filters:filters.map(x=>[...x]),projection};queries.push(entry)
   if(op!=='select')writes.push({...entry,value})
   if(options.storageError)return{data:null,error:{message:'PRIVATE_SQL_FIXTURE',code:'PRIVATE_CODE'}}
   if(table==='financial_ai_contacts'){
    if(op==='update')return{data:options.casEmpty?null:{id:contactId,human:value.human,updated_at:version},error:null}
    return{data:filters.some(x=>x[1]==='id')?contact:[contact],error:null}
   }
   if(table==='whatsapp_mensagens')return{data:[{id:'newer',direcao:'entrada'},{id:'older',direcao:'saida'}],error:null}
   if(['financial_manual_sends','financial_ai_runs'].includes(table))return{data:null,error:null}
   throw Error('UNEXPECTED_TABLE')
  }
  return q
 }
 const context=vm.createContext({AbortSignal,Date,console,process:{env:{API_SECRET_KEY:'fixture-static',JWT_SECRET:'fixture-jwt-secret'}}})
 const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v)},{context})
 const jwt={verify(token,key){verified.push({token,key});if(token!=='fixture-valid')throw Error('FIXTURE_BAD_JWT');return options.claims||{id:actor,role:'financeiro'}}}
 const authModule=new vm.SourceTextModule(await readFile(new URL('../../src/middleware/auth.js',import.meta.url),'utf8'),{context})
 await authModule.link(spec=>{assert.equal(spec,'jsonwebtoken');return synthetic({default:jwt})});await authModule.evaluate()
 const dependencies={express:{Router:express.Router},'../lib/supabase-admin.server.js':{supabase:db},
  '../lib/whatsappProviderClient.js':{createWhatsappProviderClient:()=>({get:async(...args)=>{provider.push(['get',...args]);return{data:{instance:{state:'open'}}}},post:async(...args)=>{provider.push(['post',...args]);return{data:{key:{id:'fixture-provider'}}}}}),whatsappTransportFor:async()=>'fzap'},
  '../lib/collection/doNotContactGuard.js':{estaEmDoNotContact:async()=>({blocked:false})},
  '../lib/collection/collectionContactPolicy.js':{dentroDaJanela:()=>true},
 }
 const routeModule=new vm.SourceTextModule(await readFile(new URL('../../src/routes/financial-inbox.js',import.meta.url),'utf8'),{context})
 await routeModule.link(spec=>{assert.ok(Object.hasOwn(dependencies,spec),'Unexpected route dependency');return synthetic(dependencies[spec])});await routeModule.evaluate()
 const index=await readFile(new URL('../../src/index.js',import.meta.url),'utf8')
 const line=index.split(/\r?\n/).filter(l=>l.startsWith("app.use('/api/financeiro-atendimentos',"))
 assert.equal(line.length,1,'one protected consumer must exist in index')
 const mount=express.Router()
 vm.runInNewContext(line[0],{app:mount,auth:authModule.namespace.auth,adminOuFinanceiro:authModule.namespace.adminOuFinanceiro,financialInboxRouter:routeModule.namespace.default})
 const call=(method='GET',suffix='/',body={},token='fixture-valid')=>new Promise((resolve,reject)=>{
  const headers={};const req={method,url:prefix+suffix,headers:token?{authorization:'Bearer '+token}:{},body}
  const res={statusCode:200,set(k,v){headers[k.toLowerCase()]=v;return this},status(n){this.statusCode=n;return this},json(data){resolve({code:this.statusCode,data,headers});return this}}
  mount.handle(req,res,error=>error?reject(error):resolve({code:404,headers}))
 })
 return{call,queries,writes,provider,verified}
}

test('real auth, role middleware and Router deny all four actions before business interfaces',async()=>{
 assert.equal(globalThis[Symbol.for('vivenzza.tests.networkGuardInstalled')],true)
 const routes=[['GET','/'],['GET','/'+contactId],['PATCH','/'+contactId+'/humano'],['POST','/'+contactId+'/enviar']]
 for(const input of [{token:null,code:401},{token:'invalid',code:401},{token:'fixture-static',code:403},{claims:{id:actor,role:'vendedor'},code:403},{claims:{id:actor,role:'Admin'},code:403},{claims:{id:'not-a-uuid',role:'admin'},code:403}]){
  const f=await fixture(input)
  for(const[method,path]of routes){const r=await f.call(method,path,{},Object.hasOwn(input,'token')?input.token:'fixture-valid');assert.equal(r.code,input.code)}
  assert.equal(f.queries.length,0);assert.equal(f.writes.length,0);assert.equal(f.provider.length,0)
 }
})

test('verified fake admin and financial claims reach GET consumer with no-store and scoped history',async()=>{
 for(const role of ['admin','financeiro']){
  const f=await fixture({claims:{id:actor,role}})
  const list=await f.call();assert.equal(list.code,200);assert.equal(list.headers['cache-control'],'no-store');assert.equal(list.data.data.length,1)
  const detail=await f.call('GET','/'+contactId);assert.equal(detail.code,200);assert.equal(detail.headers['cache-control'],'no-store');assert.deepEqual(detail.data.messages.map(m=>m.id),['older','newer'])
  const history=f.queries.find(q=>q.table==='whatsapp_mensagens');assert.deepEqual(history.filters,[['eq','telefone','5511000000000'],['eq','instance_name','fixture-financial']]);assert.equal(f.provider.length,0);assert.equal(f.writes.length,0)
  assert.equal(f.verified.length,2);assert.ok(f.verified.every(v=>v.key==='fixture-jwt-secret'))
 }
})

test('human takeover update retains expected identity, state and version; empty receipt is conflict',async()=>{
 for(const casEmpty of [false,true]){
  const f=await fixture({casEmpty}),body={humano:false,esperado:true,versao:version}
  const result=await f.call('PATCH','/'+contactId+'/humano',body);assert.equal(result.code,casEmpty?409:200)
  assert.equal(f.writes.length,1);assert.deepEqual(f.writes[0].filters,[['eq','id',contactId],['eq','human',true],['eq','updated_at',version]]);assert.equal(f.provider.length,0)
 }
})

test('invalid contact, state, timestamp or send intention stops before database or provider',async()=>{
 const f=await fixture()
 for(const[method,path,body]of [['GET','/invalid',{}],['PATCH','/'+contactId+'/humano',{humano:'false',esperado:true,versao:version}],['PATCH','/'+contactId+'/humano',{humano:false,esperado:true,versao:'invalid'}],['POST','/'+contactId+'/enviar',{request_id:'invalid',texto:'fixture'}]]){
  const r=await f.call(method,path,body);assert.equal(r.code,400)
 }
 assert.equal(f.queries.length,0);assert.equal(f.writes.length,0);assert.equal(f.provider.length,0)
})

test('storage error returns fixed unavailable receipt, without raw SQL detail or retry',async()=>{
 const f=await fixture({storageError:true}),r=await f.call()
 assert.equal(r.code,503);assert.equal(r.headers['cache-control'],'no-store');assert.equal(f.queries.length,1);assert.equal(f.provider.length,0)
 assert.ok(!JSON.stringify(r.data).includes('PRIVATE_SQL'));assert.ok(!JSON.stringify(r.data).includes('PRIVATE_CODE'))
})
