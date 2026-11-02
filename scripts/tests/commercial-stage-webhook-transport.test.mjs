import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source=fs.readFileSync(process.argv[2] || new URL('../../src/routes/webhook-handler.js',import.meta.url),'utf8')
const start=source.indexOf('    const { error: erroUpsertMensagem }'),end=source.indexOf('    if (mediaTipo && evolutionId)',start)
assert.ok(start>0&&end>start)
const block=source.slice(start,end)
async function run({errors=[null],financial=false,fromMe=false,freight=false,lead=true,id=true,rejectObserver=false}={}){
 const calls={upsert:0,stage:[],financialInbound:[],financialOutbound:[],logs:[]}
 const ctx={supabase:{from(table){assert.equal(table,'whatsapp_mensagens');return {async upsert(){return {error:errors[calls.upsert++]??null}}}}},payloadMensagem:{fixture:true},instanceName:'fixture-instance',ehFinanceiro:financial,freteInbound:freight,fromMe,lead:lead?{id:'fixture-lead'}:null,evolutionId:id?'fixture-evolution':null,telefone:'fixture-phone',texto:'fixture-text',msg:{messageTimestamp:1},observeCommercialStage:async x=>{calls.stage.push(x);if(rejectObserver)throw Error('PRIVATE_FIXTURE')},processFinancialInbound:async x=>{calls.financialInbound.push(x)},observeFinancialOutbound:async x=>{calls.financialOutbound.push(x)},console:{error:(...args)=>calls.logs.push(args),warn(){}}}
 await vm.runInNewContext('(async()=>{'+block+'})()',ctx);await new Promise(setImmediate);return calls
}
test('real webhook persistence block forwards both commercial directions to injected observer',async()=>{for(const fromMe of [false,true]){const c=await run({fromMe});assert.deepEqual(c.stage,['fixture-lead']);assert.equal(c.upsert,1);assert.equal(c.financialInbound.length+c.financialOutbound.length,0)}})
test('successful PGRST204 fallback reaches observer only after second upsert',async()=>{const c=await run({errors:[{code:'PGRST204',message:'FIXTURE'},null]});assert.equal(c.upsert,2);assert.deepEqual(c.stage,['fixture-lead'])})
test('failed primary or failed fallback never reaches observer',async()=>{for(const errors of [[{code:'FIXTURE',message:'FIXTURE'}],[{code:'PGRST204',message:'FIXTURE'},{code:'FIXTURE',message:'FIXTURE'}]])assert.equal((await run({errors})).stage.length,0)})
test('missing commercial lead or provider ID never reaches observer',async()=>{for(const input of [{lead:false},{id:false}])assert.equal((await run(input)).stage.length,0)})
test('Git legacy financial directions stay excluded from commercial analysis and preserve persistence',async()=>{for(const fromMe of [false,true]){const c=await run({financial:true,fromMe});assert.equal(c.stage.length,0);assert.equal(c.financialInbound.length+c.financialOutbound.length,0);assert.equal(c.upsert,1)}})
test('financial freight and fallback behavior inherited without broadening',async()=>{for(const input of [{financial:true,freight:true},{financial:true,errors:[{code:'PGRST204',message:'FIXTURE'},null]}]){const c=await run(input);assert.equal(c.stage.length,0);assert.equal(c.financialInbound.length+c.financialOutbound.length,0)}})
test('observer failure is caught with fixed diagnostic and no retry',async()=>{const c=await run({rejectObserver:true});assert.equal(c.stage.length,1);assert.deepEqual(c.logs,[['[pipeline-ai] evidence_or_update_failed']]);assert.equal(c.upsert,1)})

test('commercial-shaped freight context must not reach sales stage observer',async()=>{const c=await run({financial:false,freight:true});assert.equal(c.stage.length,0);assert.equal(c.financialInbound.length+c.financialOutbound.length,0)});
