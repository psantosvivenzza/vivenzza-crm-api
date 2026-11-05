import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import * as telephone from '../../src/lib/telefone.js'

// Real routing, pause helper and phone normalization; all external seams are fakes.
async function fixture({rows=[],error=null,reject=false,sync=true,limit=true,dnc=false,multi=false}={}) {
  const calls=[]
  const query={select(){return this},in(){return this},limit(){return this},async abortSignal(){calls.push('db');if(reject)throw Error('offline');return {data:rows,error}}}
  const db={from(table){assert.equal(table,'financial_ai_contacts');return query}}
  const context=vm.createContext({AbortSignal})
  const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value)},{context})
  const helper=new vm.SourceTextModule(await readFile(new URL('../../src/lib/collection/financialHumanPause.js',import.meta.url),'utf8'),{context})
  await helper.link(spec=>{
    if(spec==='../supabase-admin.server.js')return synthetic({supabase:db})
    if(spec==='../telefone.js')return synthetic(telephone)
    throw Error(`Unexpected helper import: ${spec}`)
  })
  const deps={
    '../evolutionFinanceiro.js':{enviarTextoFinanceiro:async()=>{calls.push('legacy')}},
    './dispatchEngine.js':{enviarComFailover:async()=>{calls.push('dispatch');return {status:'sent'}}},
    './featureFlags.js':{obterConfigCobranca:async()=>{calls.push('flags');return {multi_whatsapp:multi}}},
    './financialSyncGuard.js':{verificarFrescorSync:async()=>{calls.push('sync');return {allowed:sync,reason:'stale'}},logBloqueioSyncStale:()=>calls.push('sync-log')},
    './globalSendLimit.js':{verificarLimiteGlobalEnvio:async()=>{calls.push('limit');return {permitido:limit,motivo:'limit'}}},
    './doNotContactGuard.js':{estaEmDoNotContact:async()=>{calls.push('dnc');return {blocked:dnc,reason:'fixture'}},registrarBloqueioOptOutSeNecessario:async()=>calls.push('optout-log'),registrarBloqueioNumeroInvalidoHoje:async()=>calls.push('invalid-log')},
  }
  const routing=new vm.SourceTextModule(await readFile(new URL('../../src/lib/collection/collectionRouting.js',import.meta.url),'utf8'),{context})
  await routing.link(spec=>{if(spec==='./financialHumanPause.js')return helper;if(!deps[spec])throw Error(`Unexpected routing import: ${spec}`);return synthetic(deps[spec])})
  await routing.evaluate()
  return {calls,run:(phone='11999990000')=>routing.namespace.enviarCobrancaComRoteamento({contasFinanceirasId:'fixture',etapa:'fixture',clienteNome:'Fixture',clienteTelefone:phone,valor:0,mensagem:'fixture',origem:'test'})}
}

for(const [name,options,reason] of [
  ['human takeover',{rows:[{human:true}]},'financial_human_takeover'],
  ['query error',{error:{code:'offline'}},'human_state_unavailable'],
  ['query rejection',{reject:true},'human_state_unavailable'],
  ['missing data',{rows:null},'human_state_unavailable'],
  ['invalid boolean',{rows:[{human:'true'}]},'human_state_unavailable'],
  ['missing boolean',{rows:[{}]},'human_state_unavailable'],
])test(`${name} stops real routing before all senders and downstream guards`,async()=>{
  const f=await fixture(options);const result=await f.run();assert.equal(result.status,'blocked');assert.equal(result.reason,reason);assert.deepEqual(f.calls,['db'])
})

test('unconfirmed phone never queries or invokes senders',async()=>{const f=await fixture();assert.equal((await f.run('abc')).reason,'phone_not_confirmed');assert.deepEqual(f.calls,[])})
test('proven absence preserves sync guard',async()=>{const f=await fixture({sync:false});assert.equal((await f.run()).reason,'stale');assert.deepEqual(f.calls,['db','sync','sync-log'])})
test('proven absence preserves global limit',async()=>{const f=await fixture({limit:false});assert.equal((await f.run()).reason,'limit');assert.deepEqual(f.calls,['db','sync','limit'])})
test('proven absence preserves DNC before engine selection',async()=>{const f=await fixture({dnc:true});assert.equal((await f.run()).reason,'opt_out');assert.deepEqual(f.calls,['db','sync','limit','dnc','optout-log'])})
for(const multi of [false,true])test(`clear pause state uses exactly the selected fake engine: ${multi}`,async()=>{const f=await fixture({rows:[{human:false}],multi});const r=await f.run();assert.equal(r.status,'sent');assert.equal(r.motor,multi?'v2':'legado');assert.deepEqual(f.calls,['db','sync','limit','dnc','flags',multi?'dispatch':'legacy'])})
