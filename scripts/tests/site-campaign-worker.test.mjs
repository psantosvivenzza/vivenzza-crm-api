import test from 'node:test'
import assert from 'node:assert/strict'
import { createSiteCampaignWorker } from '../../src/jobs/site-campaign.js'
const env={SDR_SITE_ENABLED:'true',SDR_SITE_INSTANCE:'site',EVOLUTION_INSTANCE:'vivenzza'}
const cfg={enabled:true,ai_verified:true,instance_name:'site'}
const c={id:'c',lead_id:'l',telefone:'5551999999999',nome:'Cliente Teste'}
function fixture(script, providerError=false){
 const calls=[];const sent=[]
 const db={from(table){const step=script.shift();assert.equal(table,step.table);const q=new Proxy({}, {get(_t,k){if(k==='then')return r=>r(step.result);return (...args)=>{calls.push({table,method:k,args});return q}}});return q},async rpc(name){const step=script.shift();assert.equal(name,step.rpc);return step.result}}
 const api={async post(url,body){sent.push({url,body});if(providerError)throw Error('timeout');return {data:{key:{id:'provider-id'}}}}}
 return {run:createSiteCampaignWorker({db,api,env,mediaUrl:'https://example.com/image.jpg'}),calls,sent}
}
const r=(table,data,error=null)=>({table,result:{data,error}})
const first=()=>[r('site_campaign_config',cfg),{rpc:'claim_site_campaign_contact',result:{data:[c]}}]
test('opt-out prevents any provider call',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',whatsapp_opt_out:true,ativo:true}]),r('site_campaign_contacts',null)])
 assert.equal((await f.run()).status,'blocked');assert.equal(f.sent.length,0)
})
test('human takeover prevents any provider call',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',atendimento_humano:true,ativo:true}]),r('site_campaign_contacts',null)])
 assert.equal((await f.run()).status,'blocked');assert.equal(f.sent.length,0)
})
function ready(){return [...first(),r('leads',[{id:'l',ativo:true}]),r('site_campaign_config',cfg),r('site_campaign_contacts',{status:'reserved'})]}
test('reply received before dispatch cancels promotion',async()=>{
 const steps=ready();steps[4]=r('site_campaign_contacts',{status:'replied'});const f=fixture(steps)
 assert.equal((await f.run()).status,'cancelled');assert.equal(f.sent.length,0)
})
test('provider timeout pauses without retry',async()=>{
 const f=fixture([...ready(),r('site_campaign_config',null),r('site_campaign_contacts',null)],true)
 assert.equal((await f.run()).status,'paused');assert.equal(f.sent.length,1)
 assert.equal(f.calls.some(c=>c.args[0]?.status==='uncertain'),true)
})
test('one image with approved caption uses dedicated number and records instance',async()=>{
 const f=fixture([...ready(),r('whatsapp_mensagens',null),r('site_campaign_contacts',null),r('site_campaign_contacts',null)])
 assert.equal((await f.run()).status,'sent');assert.equal(f.sent.length,1);assert.equal(f.sent[0].url,'/message/sendMedia/site');assert.match(f.sent[0].body.caption,/VOLTE10/);assert.doesNotMatch(f.sent[0].body.caption,/responda SAIR/)
 assert.equal(f.calls.find(c=>c.table==='whatsapp_mensagens'&&c.method==='insert').args[0].instance_name,'site')
})
