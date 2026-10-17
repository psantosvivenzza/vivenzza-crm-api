import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const fixture=globalThis[Symbol.for('vivenzza.atomic.rpc')]={calls:[],response:null}
fixture.client={rpc:async(name,args)=>{fixture.calls.push({name,args});return fixture.response},from(){throw Error('Standalone writes forbidden')}}
registerHooks({resolve(s,c,next){return s.endsWith('/supabase-admin.server.js')?{shortCircuit:true,url:"data:text/javascript,export const supabase=globalThis[Symbol.for('vivenzza.atomic.rpc')].client"}:next(s,c)}})
const {cancelarAutomacaoPorPagamento}=await import('../../../src/lib/collection/paymentGuard.js')
const {marcarPromessaCumprida}=await import('../../../src/lib/collection/promises.js')
test('payment DTO and arguments preserved',async()=>{const dto={dispatches:1,promessaCumprida:true,ligacoes:0,motivo:'quitado'};fixture.response={data:dto,error:null};assert.deepEqual(await cancelarAutomacaoPorPagamento('synthetic-title'),dto);assert.deepEqual(fixture.calls.at(-1),{name:'collection_cancel_paid_atomic',args:{p_title_id:'synthetic-title'}})})
test('fulfilled promise return and default origin',async()=>{fixture.response={data:{id:'synthetic-promise',status:'cumprida'},error:null};assert.equal((await marcarPromessaCumprida('synthetic-promise')).status,'cumprida');assert.equal(fixture.calls.at(-1).args.p_origin,'SYSTEM')})
test('explicit origin and no-op null',async()=>{fixture.response={data:null,error:null};assert.equal(await marcarPromessaCumprida('synthetic-promise',{origem:'PAYMENT_RECONCILIATION'}),null);assert.equal(fixture.calls.at(-1).args.p_origin,'PAYMENT_RECONCILIATION')})
for(const fn of [cancelarAutomacaoPorPagamento,marcarPromessaCumprida])test(fn.name+' propagates failure without fallback',async()=>{const error={code:'SYNTHETIC_TX_ROLLBACK'};fixture.response={data:null,error};await assert.rejects(()=>fn('synthetic-id'),e=>e===error)})
