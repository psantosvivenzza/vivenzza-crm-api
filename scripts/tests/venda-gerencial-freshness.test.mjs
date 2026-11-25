import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
const context=vm.createContext({Date,Number,Math,process:{env:{}},AbortSignal})
const module=new vm.SourceTextModule(readFileSync('src/lib/vendaGerencialSyncStatus.js','utf8'),{context})
await module.link(()=>new vm.SyntheticModule(['supabase'],function(){this.setExport('supabase',{})},{context}))
await module.evaluate()
const {avaliarStatusSyncGerencial:check,verificarStatusSyncGerencial:query}=module.namespace
const now=Date.parse('2026-11-25T12:00:00Z')
const good={status:'concluido',concluido_em:new Date(now-600000).toISOString(),total_com_erro:0}
test('strict thirty-minute boundary and future/malformed timestamps',()=>{
 assert.equal(check(good,{now}).disponivel,true)
 assert.equal(check({...good,concluido_em:new Date(now-1800000).toISOString()},{now}).disponivel,true)
 for(const stamp of [new Date(now-1800001).toISOString(),new Date(now+1).toISOString(),'bad',null]) assert.equal(check({...good,concluido_em:stamp},{now}).disponivel,false)
})
test('only clean completed cycles count as fresh',()=>{
 for(const status of ['falhou','executando','unknown',null]) assert.equal(check({...good,status},{now}).disponivel,false)
 for(const total_com_erro of [1,-1,'invalid']) assert.equal(check({...good,total_com_erro},{now}).disponivel,false)
 assert.equal(check(null,{now}).disponivel,false)
})
test('query fails closed and old environment cannot extend freshness',async()=>{
 context.process.env.VENDAS_GERENCIAIS_SYNC_MAX_ATRASO_MIN='1440'
 const result=await query({clienteSupabase:{from(){throw Error('offline')}}})
 assert.equal(result.disponivel,false)
 assert.equal(result.max_age_minutes,30)
})
test('running cycle preserves preceding fresh completed snapshot; failed latest does not',async()=>{
 const makeClient=rows=>({from(){return this},select(){return this},eq(){return this},order(){return this},limit(n){assert.equal(n,2);return this},abortSignal(signal){assert.equal(signal.aborted,false);return Promise.resolve({data:rows,error:null})}})
 const completed={...good,concluido_em:new Date(Date.now()-600000).toISOString()}
 assert.equal((await query({clienteSupabase:makeClient([{status:'executando'},completed])})).disponivel,true)
 assert.equal((await query({clienteSupabase:makeClient([{status:'falhou'},completed])})).disponivel,false)
 assert.equal((await query({clienteSupabase:makeClient([{status:'executando'},{...completed,concluido_em:'2020-01-01T00:00:00Z'}])})).disponivel,false)
})

