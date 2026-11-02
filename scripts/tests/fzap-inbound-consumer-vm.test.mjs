import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createFzapWebhookHandler, evolutionOwnership } from '../../src/lib/whatsappInboundOwnership.js'
import { fzapWebhookSecret } from '../../src/lib/fzapWebhookSecret.js'
import { normalizeFzapWebhook } from '../../src/lib/fzapWebhookEvents.js'

const read = rel => readFileSync(new URL('../../'+rel, import.meta.url),'utf8')
const sdr = read('src/routes/sdr.js')
const response = () => ({statusCode:200,headersSent:false,status(n){this.statusCode=n;return this},json(body){assert.equal(this.headersSent,false);this.body=body;this.headersSent=true;return this}})

test('FZap SDR wrapper preserves async instance context and rejects Site/missing instance',async()=>{
 const start=sdr.indexOf('export function handleFzapSdrWebhook('),end=sdr.indexOf("\nrouter.post('/webhook'",start)
 assert.ok(start>=0&&end>start)
 const store=new AsyncLocalStorage(),seen=[]
 const handler=runInNewContext(sdr.slice(start,end).replace('export ','')+'\nhandleFzapSdrWebhook',{
  process:{env:{SDR_SITE_INSTANCE:'fixture-site'}},sdrContext:store,
  handleSdrWebhook:async(req,res)=>{await Promise.resolve();seen.push({...store.getStore()});res.json({status:'received'})},
 })
 for(const body of [{},{instance:''},{instance:'fixture-site'},{instance:'Mesagens Site Reativação'}]){
  const res=response();await handler({body},res);assert.equal(res.statusCode,body.instance?403:503)
 }
 await Promise.all(['alpha','beta'].map(instance=>handler({body:{instance}},response())))
 assert.deepEqual(seen,[{instance:'alpha',provider:'fzap'},{instance:'beta',provider:'fzap'}]);assert.equal(store.getStore(),undefined)
})

test('real Site receipt handler carries provider only for explicit FZap and preserves rejection',async()=>{
 const start=sdr.indexOf('export async function handleSiteCampaignWebhook('),end=sdr.indexOf("\nrouter.post('/site-reativacao/webhook'",start)
 assert.ok(start>=0&&end>start)
 const seen=[],contexts=[];let enabled=true
 const handler=runInNewContext(sdr.slice(start,end).replace('export ','')+'\nhandleSiteCampaignWebhook',{
  siteCampaignContext:()=>{if(!enabled)return null;const context={instance:'fixture-site'};contexts.push(context);return context},
  applySiteCampaignReceipts:async(db,body,instance)=>seen.push({instance,body}),supabase:{},console:{error(){throw Error('unexpected log')}},
 })
 for(const options of [{},{provider:'fzap'}]){const res=response();await handler({body:{event:'messages.update'}},res,options);assert.equal(res.body.status,'ok')}
 enabled=false;const rejected=response();await handler({body:{}},rejected,{provider:'fzap'});assert.equal(rejected.statusCode,403);assert.equal(seen.length,2);assert.equal(contexts[0].provider,undefined);assert.equal(contexts[1].provider,'fzap')
})

test('index mounts real ownership and dispatcher with explicit callbacks before business work',async()=>{
 assert.equal(globalThis[Symbol.for('vivenzza.tests.networkGuardInstalled')],true)
 const index=read('src/index.js'),start=index.indexOf("app.post('/api/whatsapp/webhook'"),end=index.indexOf('\n// Rate limit',start)
 assert.ok(start>=0&&end>start)
 const routes=[],calls=[],secret='fixture-only-'.repeat(4)
 const handleWebhook=()=>{},processWhatsappEvent=async(event,options)=>calls.push({domain:'financial',instance:event.instance,expected:options.financialExpected})
 const handleFzapSdrWebhook=(req,res)=>{calls.push({domain:'commercial',instance:req.body.instance});res.json({status:'received'})}
 const handleSiteCampaignWebhook=(req,res,options)=>{calls.push({domain:'site',instance:req.body.instance,provider:options.provider});res.json({status:'received'})}
 const connections=[{id:'fin',instanceName:'financial',finalidade:'financeiro'},{id:'sales',instanceName:'commercial',finalidade:'comercial'},{id:'site',instanceName:'site',finalidade:'comercial'}]
 runInNewContext(index.slice(start,end),{app:{post:(...args)=>routes.push(args)},handleWebhook,evolutionOwnership,webhookAuth:()=>{},processWhatsappEvent,handleFzapSdrWebhook,handleSiteCampaignWebhook,
  createFzapWebhookHandler:options=>createFzapWebhookHandler({...options,env:{FZAP_WEBHOOK_SECRET:secret,SDR_SITE_INSTANCE:'site'},getConfig:()=>({connections}),transportFor:async()=>'fzap',financialCheck:async name=>name==='financial'}),
 })
 assert.equal(routes.length,2);assert.equal(routes[0][2],evolutionOwnership);assert.equal(routes[0][3],handleWebhook);assert.equal(routes[1][0],'/api/whatsapp/fzap-webhook/:id')
 for(const id of ['fin','sales','site']){
  const req={params:{id},headers:{'x-fzap-webhook-token':fzapWebhookSecret(secret,id)},body:{type:'Message',event:{Info:{ID:'fixture-'+id,Chat:'5511000000000@s.whatsapp.net',IsFromMe:false},Message:{conversation:'fixture'}}}}
  const res=response();await routes[1][1](req,res);assert.equal(res.statusCode,200);assert.equal(res.body.status,'received')
 }
 assert.deepEqual(calls,[{domain:'financial',instance:'financial',expected:true},{domain:'commercial',instance:'commercial'},{domain:'site',instance:'site',provider:'fzap'}])
})

test('LID without a valid explicit phone alternate never becomes a phone identity',()=>{
 for(const IsFromMe of [false,true])for(const alternate of [undefined,'123@lid','invalid','5511000000000:abc@s.whatsapp.net']){
  const Info={ID:'fixture-lid',Chat:'123:2@lid',IsFromMe,[IsFromMe?'RecipientAlt':'SenderAlt']:alternate}
  assert.equal(normalizeFzapWebhook({type:'Message',event:{Info,Message:{conversation:'fixture'}}},'financial'),null)
 }
})

test('real financial dispatcher ignores unresolved LID before registry, inbox or model callback',async()=>{
 const secret='fixture-only-'.repeat(4);let registry=0,dispatch=0
 const handler=createFzapWebhookHandler({env:{FZAP_WEBHOOK_SECRET:secret},getConfig:()=>({connections:[{id:'fin',instanceName:'financial',finalidade:'financeiro'}]}),transportFor:async()=>'fzap',financialCheck:async()=>{registry++;return true},financial:async()=>{dispatch++}})
 const res=response();await handler({params:{id:'fin'},headers:{'x-fzap-webhook-token':fzapWebhookSecret(secret,'fin')},body:{type:'Message',event:{Info:{ID:'fixture-lid',Chat:'123@lid',IsFromMe:false},Message:{conversation:'fixture'}}}},res)
 assert.equal(res.body.status,'ignored');assert.equal(registry,0);assert.equal(dispatch,0)
})
