import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source=readFileSync(new URL('../../src/index.js',import.meta.url),'utf8')
const ending="}, {name:'financial-ai-recovery',noOverlap:true})"
const endingStart=source.indexOf(ending)
const start=source.lastIndexOf("cron.schedule('* * * * *', async () => {",endingStart)
const end=endingStart+ending.length
assert.ok(endingStart>=0&&start>=0&&end>start,'existing recovery callback must be integrated in index')
const callbackSource=source.slice(start,end)
function fixture(result={data:0,error:null},mode='resolve') {
 const calls=[],logs=[],registrations=[]
 runInNewContext(callbackSource,{
  cron:{schedule:(...args)=>registrations.push(args)},
  supabase:{rpc:(...args)=>{calls.push(args);if(mode==='throw')throw Error('fixture-private');return mode==='reject'?Promise.reject(Error('fixture-private')):Promise.resolve(result)}},
  console:{error:(...args)=>logs.push(args)},
 })
 assert.equal(registrations.length,1)
 return{calls,logs,registrations,run:registrations[0][1]}
}

test('real callback registers once without executing storage or creating a real timer',()=>{
 assert.equal(globalThis[Symbol.for('vivenzza.tests.networkGuardInstalled')],true)
 const f=fixture(),[expression,run,options]=f.registrations[0]
 assert.equal(expression,'* * * * *');assert.equal(typeof run,'function');assert.equal(options.name,'financial-ai-recovery');assert.equal(options.noOverlap,true);assert.equal(options.timezone,undefined)
 assert.equal(f.calls.length,0);assert.equal(f.logs.length,0)
})

test('successful fake receipt invokes only the named recovery RPC once, with no parameters',async()=>{
 for(const data of [0,5]){
  const f=fixture({data,error:null});assert.equal(await f.run(),undefined)
  assert.deepEqual(f.calls,[['reap_financial_ai_runs']]);assert.deepEqual(f.logs,[])
 }
})

test('database error receipt gives one fixed diagnostic without retry or raw error',async()=>{
 const f=fixture({data:null,error:{message:'fixture-private',code:'fixture-code'}});await f.run()
 assert.deepEqual(f.calls,[['reap_financial_ai_runs']]);assert.deepEqual(f.logs,[['[financial-ai] recovery_unavailable']])
})

test('rejected and synchronously thrown RPC errors are observed without retry',async()=>{
 for(const mode of ['reject','throw']){
  const f=fixture(undefined,mode);await f.run()
  assert.deepEqual(f.calls,[['reap_financial_ai_runs']]);assert.deepEqual(f.logs,[['[financial-ai] recovery_unavailable']])
 }
})

test('null fake receipt follows the existing catch, never inventing recovery count',async()=>{
 const f=fixture(null);assert.equal(await f.run(),undefined)
 assert.deepEqual(f.calls,[['reap_financial_ai_runs']]);assert.deepEqual(f.logs,[['[financial-ai] recovery_unavailable']])
})
