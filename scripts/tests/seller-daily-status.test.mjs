import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {selectCommercialRecipient} from '../../src/lib/sellerDailyBrief.js'
const {Router}=createRequire(import.meta.url)('express')
const source=readFileSync(new URL('../../src/routes/automacoes.js',import.meta.url),'utf8')
// The legacy guard's configured identity is read privately from the real module, never logged.
const admin=source.match(/const SUPER_ADMIN_EMAIL = '([^']+)'/)[1]
const OWN='5511999990099',COMMERCIAL='5511999990001'
async function request(options={}){
 const {ready=true,authorized=true,method='GET',url='/status'}=options
 const role=Object.hasOwn(options,'role')?options.role:'admin'
 const flag=Object.hasOwn(options,'flag')?options.flag:'true',recipient=Object.hasOwn(options,'recipient')?options.recipient:COMMERCIAL
 let readyCalls=0,reads=0
 const env={SELLER_DAILY_BRIEF_ENABLED:flag,DIRECTION_REPORT_NUMBER:OWN,LEADS_PARADOS_COMERCIAL_NUMBER:recipient}
 const db={from(table){reads++;const q={select(){return q},eq(){return q},gte(){return q},order(){return q},limit(){return q},single(){return q},maybeSingle(){return q},then(resolve,reject){return Promise.resolve({data:table==='automacoes_config'?{sdr_ativo:false,voz_ativa:true}:{ultimo_contato:null},count:0,error:null}).then(resolve,reject)}};return q}}
 const axios={create:()=>({get:async()=>({data:{instance:{state:'open'}}})}),get:async()=>({data:{}})}
 const deps={express:{Router},axios:{default:axios},'../lib/supabase-admin.server.js':{supabase:db},'../lib/sellerDailyBrief.js':{selectCommercialRecipient},'../lib/directionNotifications.js':{enviarNotificacaoDirecao:{ready:async()=>{readyCalls++;if(ready==='throw')throw Error('fake readiness unavailable');return ready}}}}
 const context=vm.createContext({process:{env},console})
 const module=new vm.SourceTextModule(source,{context})
 await module.link(name=>{const values=deps[name];assert.ok(values,`Unexpected import ${name}`);return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v] of Object.entries(values))this.setExport(k,v)},{context})})
 await module.evaluate()
 const response=await new Promise((resolve,reject)=>{
  const req={method,url,originalUrl:url,headers:{},user:authorized===true?{email:admin,role}:authorized==='wrong'?{email:'not-authorized@example.invalid',role:'admin'}:undefined}
  const res={statusCode:200,status(n){this.statusCode=n;return this},json(body){resolve({status:this.statusCode,body});return this}}
  module.namespace.default.handle(req,res,error=>reject(error||Error('No response')))
 })
 return {response,readyCalls,reads}
}
test('real Router GET status integrates single team capability and preserves legacy fields',async()=>{const r=await request();assert.equal(r.response.status,200);assert.equal(r.readyCalls,1);assert.equal(r.response.body.capacidades.length,1);const c=r.response.body.capacidades[0];assert.equal(c.id,'vendedores-resumo');assert.equal(c.estado,'habilitado');assert.match(c.nome,/9h05/);assert.match(c.detalhe,/Uma mensagem diária no Comercial/);for(const key of ['sdr','evolution','elevenlabs','anthropic'])assert.ok(key in r.response.body)})
test('disabled or nonliteral flag avoids new direction readiness reads',async()=>{for(const flag of ['false',undefined,'TRUE']){const r=await request({flag});assert.equal(r.response.status,200);assert.equal(r.readyCalls,0);assert.equal(r.response.body.capacidades[0].estado,'pausado')}})
test('missing invalid or own Commercial is blocked before notifier readiness',async()=>{for(const recipient of [undefined,'',OWN,'551199990099','bad']){const r=await request({recipient});assert.equal(r.response.status,200);assert.equal(r.readyCalls,0);assert.equal(r.response.body.capacidades[0].estado,'bloqueado')}})
test('unavailable direction cannot claim enabled or delivery',async()=>{const r=await request({ready:false});assert.equal(r.readyCalls,1);assert.equal(r.response.body.capacidades[0].estado,'bloqueado');assert.equal(r.response.body.capacidades[0].ativo,true);assert.match(r.response.body.capacidades[0].detalhe,/não comprova entrega/)})
test('real Router authorization rejects before database and notifier reads',async()=>{for(const authorized of [false,'wrong']){const r=await request({authorized});assert.equal(r.response.status,403);assert.equal(r.reads,0);assert.equal(r.readyCalls,0)}})

test('readiness rejection or nonboolean cannot break legacy status or enable card',async()=>{for(const ready of ['throw','true']){const r=await request({ready});assert.equal(r.response.status,200);assert.equal(r.response.body.capacidades[0].estado,'bloqueado');assert.ok(r.response.body.sdr);assert.ok(r.response.body.evolution)}})

test('matching identity without literal admin role is denied before reads on status and legacy operations',async()=>{
 for(const role of [undefined,null,'vendedor','gestor','Admin','',false]){
  for(const [method,url] of [['GET','/status'],['POST','/sdr/toggle'],['POST','/voz/toggle'],['POST','/evolution/reconectar']]){
   const r=await request({role,method,url});assert.equal(r.response.status,403);assert.equal(r.reads,0);assert.equal(r.readyCalls,0)
  }
 }
})
