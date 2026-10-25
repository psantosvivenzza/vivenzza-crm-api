import test from 'node:test'
import assert from 'node:assert/strict'
import { createSiteCampaignWorker, checkSiteRecipient } from '../../src/jobs/site-campaign.js'
const env={SDR_SITE_ENABLED:'true',SDR_SITE_INSTANCE:'site',EVOLUTION_INSTANCE:'vivenzza'}
const cfg={enabled:true,ai_verified:true,instance_name:'site'}
const c={id:'c',lead_id:'l',telefone:'5551999999999',nome:'Cliente Teste'}
function fixture(script, providerError=false, numberCheck=[{number:c.telefone,exists:true,jid:c.telefone+'@s.whatsapp.net'},{number:'555199999999',exists:false}]){
 const calls=[];const sent=[]
 const db={from(table){const step=script.shift();assert.equal(table,step.table);const q=new Proxy({}, {get(_t,k){if(k==='then')return r=>r(step.result);return (...args)=>{calls.push({table,method:k,args});return q}}});return q},async rpc(name){const step=script.shift();assert.equal(name,step.rpc);return step.result}}
 const api={async get(){return {data:{instance:{state:'open'}}}},async post(url,body){if(url.startsWith('/chat/whatsappNumbers/')){if(numberCheck instanceof Error)throw numberCheck;return {data:numberCheck}}sent.push({url,body});if(providerError)throw Error('timeout');return {data:{key:{id:'provider-id'}}}}}
 return {run:createSiteCampaignWorker({db,api,env,mediaUrl:'https://example.com/image.jpg'}),calls,sent}
}
const r=(table,data,error=null)=>table==='leads'?{rpc:'site_campaign_leads_for_contact',result:{data:data?.map(l=>({telefone:c.telefone,...l})),error}}:{table,result:{data,error}}
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

test('formatted linked phone dispatches normally',async()=>{
 const steps=ready();steps[2]=r('leads',[{id:'l',telefone:'(51) 99999-9999',ativo:true}]);
 const f=fixture([...steps,r('whatsapp_mensagens',null),r('site_campaign_contacts',null),r('site_campaign_contacts',null)]);
 assert.equal((await f.run()).status,'sent');assert.equal(f.sent.length,1)
})
test('changed linked phone pauses before provider IO',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',telefone:'5551988887777',ativo:true}]),r('site_campaign_config',null),r('site_campaign_contacts',null)]);
 assert.equal((await f.run()).status,'paused');assert.equal(f.sent.length,0)
})


test('number definitively absent is blocked without pausing campaign or sending media',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',ativo:true}]),r('site_campaign_contacts',null)],false,[{number:c.telefone,exists:false},{number:'555199999999',exists:false}]);
 assert.equal((await f.run()).status,'blocked');assert.equal(f.sent.length,0);
 assert.equal(f.calls.some(c=>c.table==='site_campaign_config'&&c.method==='update'),false);
 assert.equal(f.calls.some(c=>c.args[0]?.last_error==='recipient_not_on_whatsapp'),true)
})
test('number lookup outage pauses without media or retry',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',ativo:true}]),r('site_campaign_config',null),r('site_campaign_contacts',null)],false,Error('timeout'));
 assert.equal((await f.run()).status,'paused');assert.equal(f.sent.length,0)
})
test('mismatched number response cannot authorize dispatch',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',ativo:true}]),r('site_campaign_config',null),r('site_campaign_contacts',null)],false,[{number:'5551988887777',exists:true}]);
 assert.equal((await f.run()).status,'paused');assert.equal(f.sent.length,0)
})


test('ninth-digit variant may resolve to the provider canonical jid',async()=>{
 const api={post:async()=>({data:[{number:c.telefone,exists:false},{number:'555199999999',exists:true,jid:'555199999999@s.whatsapp.net'}]})};
 assert.deepEqual(await checkSiteRecipient(api,'site',c.telefone),{exists:true,number:'555199999999'})
})
test('recipient check rejects malformed, incomplete, ambiguous and foreign jid responses',async()=>{
 for(const rows of [[],[{number:c.telefone,exists:'false'}],[{number:c.telefone,exists:false},{number:c.telefone,exists:false}], [{number:c.telefone,exists:true,jid:'5551988887777@s.whatsapp.net'},{number:'555199999999',exists:false}]]){
 await assert.rejects(()=>checkSiteRecipient({post:async()=>({data:rows})},'site',c.telefone))
 }
})
test('pre-send lookup failure keeps recipient pending, not uncertain',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',ativo:true}]),r('site_campaign_config',null),r('site_campaign_contacts',null)],false,Error('timeout'));
 await f.run();assert.equal(f.calls.some(c=>c.args[0]?.status==='pending'),true)
})
test('failed invalid-recipient persistence pauses without sending',async()=>{
 const f=fixture([...first(),r('leads',[{id:'l',ativo:true}]),r('site_campaign_contacts',null,{code:'db'}),r('site_campaign_config',null),r('site_campaign_contacts',null)],false,[{number:c.telefone,exists:false},{number:'555199999999',exists:false}]);
 assert.equal((await f.run()).status,'paused');assert.equal(f.sent.length,0)
})

test('worker sends media to the validated canonical provider number',async()=>{
 const f=fixture([...ready(),r('whatsapp_mensagens',null),r('site_campaign_contacts',null),r('site_campaign_contacts',null)],false,[{number:c.telefone,exists:false},{number:'555199999999',exists:true,jid:'555199999999@s.whatsapp.net'}]);
 assert.equal((await f.run()).status,'sent');assert.equal(f.sent[0].body.number,'555199999999')
})


test('local formatted phone checks both full international variants',async()=>{
 let checked;
 const result=await checkSiteRecipient({post:async(_url,body)=>{checked=body.numbers;return {data:[{number:c.telefone,exists:true,jid:c.telefone+'@s.whatsapp.net'},{number:'555199999999',exists:false}]}}},'site','(51) 99999-9999');
 assert.deepEqual(new Set(checked),new Set([c.telefone,'555199999999']));assert.equal(result.number,c.telefone)
})
test('different positive canonical jids fail closed',async()=>{
 await assert.rejects(()=>checkSiteRecipient({post:async()=>({data:[{number:c.telefone,exists:true,jid:c.telefone+'@s.whatsapp.net'},{number:'555199999999',exists:true,jid:'555199999999@s.whatsapp.net'}]})},'site',c.telefone),/ambiguous_recipient_jid/)
})
