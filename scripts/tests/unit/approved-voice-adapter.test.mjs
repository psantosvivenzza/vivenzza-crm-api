import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
const now = new Date('2026-10-19T15:00:00Z')
const entries = Array.from({length:120},(_,i)=>({code:String(i).padStart(6,'0'),name:'Sintético'}))
const saved={code:'000004',name:'Sintético',phone:'5511999998888',totalCents:30000,accountIds:['boleto1','boleto2'],status:'ready'}
const audit={campaign:'atrasados-20261019',at:now.toISOString(),today:'2026-10-19',entries,plans:entries.map(e=>e.code===saved.code?saved:{...e,status:'blocked'})}
const candidate={codigo_cliente:'000004',cliente:'Sintético',telefone:'11999998888',valor_total:'300.00'}
let blocked=null,claimCount=0,closed=0,locks=0,sourceFailure=false
const accounts=['boleto1','boleto2'].map(id=>({codigo_cliente:'000004',id,telefone_cobranca:saved.phone,status:'vencida',vencimento:'2026-01-01'}))
const crm={from(table){const q={select(){return q},eq(){return q},in(){return q},gte(){return q},limit(){return q},insert(){claimCount++;return q},single(){return q},then(resolve){return Promise.resolve(table==='integration_events'?{data:{id:'synthetic'},error:blocked==='duplicate'?{code:'23505'}:null}:{data:blocked===table?[{id:'blocked'}]:[],error:null}).then(resolve)}};return q}}
mock.module('node:fs',{defaultExport:{readFileSync:()=>JSON.stringify(audit),openSync:()=>{locks++;return 1},closeSync:()=>{},unlinkSync:()=>{locks--}}})
mock.module('../../../scripts/audit-approved-portfolio.mjs',{namedExports:{entriesFromPdf:()=>entries,crmClient:()=>crm,sourceClient:async()=>({end:async()=>{closed++}}),sourceRows:async()=>{if(sourceFailure)throw Error('source_offline');return []},loadAccounts:async()=>accounts,reconcile:()=>({...saved}),reportPath:'C:/synthetic/audit.json'}})
mock.module('../../../src/lib/collection/doNotContactGuard.js',{namedExports:{estaEmDoNotContact:async(number,channels)=>{assert.deepEqual(channels,['todos','ligacao','whatsapp']);return {blocked:blocked==='dnc'}}}})
mock.module('../../../src/lib/collection/financialSyncGuard.js',{namedExports:{verificarFrescorSync:async()=>({allowed:blocked!=='sync'})}})
const {openApprovedVoiceScope}=await import('../../voice/approved-portfolio-scope.mjs')
test('adapter real revalida antes da reserva, falha fechado e fecha recursos',async t=>{
 mock.timers.enable({apis:['Date'],now})
 delete process.env.VOICE_QUEUE_GENERAL_ENABLED
 const scope=await openApprovedVoiceScope()
 assert.deepEqual(scope.codes,['000004'])
 assert.deepEqual(scope.allowlist,['+5511999998888'])
 const config={voice_external_enabled:false,whatsapp_failover:false}
 assert.equal(scope.flags(config).voice_external_enabled,true)
 assert.equal(config.voice_external_enabled,false)
 assert.throws(()=>scope.flags({voice_external_enabled:true}),/voz_global/)
 for(const reason of ['sync','dnc','collection_promises','whatsapp_mensagens']) await t.test(reason,async()=>{
  blocked=reason;const before=claimCount;await assert.rejects(scope.reserve(candidate));assert.equal(claimCount,before)
 })
 await t.test('origem indisponível não reserva',async()=>{blocked=null;sourceFailure=true;await assert.rejects(scope.reserve(candidate));assert.equal(claimCount,0);sourceFailure=false})
 await t.test('fora da carteira não reserva',async()=>{await assert.rejects(scope.reserve({...candidate,codigo_cliente:'000005'}));assert.equal(claimCount,0)})
 await t.test('contexto falado incluindo dívida antiga é recusado',async()=>{
  accounts.push({codigo_cliente:'000004',id:'antiga',status:'vencida',vencimento:'2024-01-01',telefone_cobranca:saved.phone})
  await assert.rejects(scope.reserve(candidate),/contexto_falado_fora_do_escopo/);assert.equal(claimCount,0);accounts.pop()
 })
 await t.test('reserva única e duplicata incerta não são liberadas',async()=>{
  assert.equal(await scope.reserve(candidate),true);assert.equal(claimCount,1)
  blocked='duplicate';await assert.rejects(scope.reserve(candidate),/ligacao_ja_reservada/);assert.equal(claimCount,2)
 })
 await scope.close();assert.equal(closed,1);assert.equal(locks,0)
 process.env.VOICE_QUEUE_GENERAL_ENABLED='true'
 await assert.rejects(openApprovedVoiceScope(),/fila_global/)
 assert.equal(locks,0)
 delete process.env.VOICE_QUEUE_GENERAL_ENABLED
 mock.timers.reset()
})
