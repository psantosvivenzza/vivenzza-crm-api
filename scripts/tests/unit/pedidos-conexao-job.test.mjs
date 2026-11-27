import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

let state
const ref = 'globalThis.__pedidosConexaoJobTeste'
const doubles = new Map([
  ['pg', `export default {Pool:class {async query(sql){return ${ref}.query(sql)} async end(){${ref}.closed++}}}`],
  ['../lib/supabase-admin.server.js', `export const supabase={from:t=>${ref}.from(t)}`],
  ['../lib/e01Host.js', 'export async function configE01(){return {}}'],
  ['../lib/fretes/netvision.js', 'export async function lerLogisticaNetvision(){throw Error("proibido")}'],
  ['./sync-logistica-produtos.js', 'export async function sincronizarLogisticaProdutos(){throw Error("proibido")}'],
])
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (doubles.has(specifier)) return { shortCircuit:true, url:'data:text/javascript,'+encodeURIComponent(doubles.get(specifier)) }
  if (specifier.startsWith('node:') || specifier.endsWith('/sync-pedidos-legado.js') || specifier === '../lib/pedidos-conexao.js') return next(specifier, context)
  throw Error('Import real proibido no teste')
} })
const { executarSincronizacaoPedidos } = await import('../../../src/jobs/sync-pedidos-legado.js')
hooks.deregister()

test('job real persiste somente diagnóstico sanitizado e aborta antes de ler pedidos', async () => {
  state = { closed:0, queries:[], updates:[] }
  state.query = async sql => {
    state.queries.push(sql)
    throw Object.assign(new Error('senha-host-cliente-secreto'), { code:'28P01' })
  }
  state.from = table => {
    assert.equal(table, 'sincronizacoes_pedidos')
    let payload
    const q = {
      select(){return q},in(){return q},not(){return q},order(){return q},limit(){return q},eq(){return q},
      insert(){return q},update(v){payload=v;return q},
      async maybeSingle(){return {data:null,error:null}},
      async single(){return {data:{id:'sync-sintetica'},error:null}},
      then(resolve,reject){state.updates.push(payload);return Promise.resolve({error:null}).then(resolve,reject)},
    }
    return q
  }
  globalThis.__pedidosConexaoJobTeste=state
  const oldFlag=process.env.FRETE_LOGISTICA_SYNC_ATIVA
  process.env.FRETE_LOGISTICA_SYNC_ATIVA='false'
  try {
    await assert.rejects(executarSincronizacaoPedidos(), err => {
      assert.match(err.message, /Código: 28P01\./)
      assert.doesNotMatch(err.message, /secreto/)
      return true
    })
    assert.deepEqual(state.queries, ['SELECT 1'])
    assert.equal(state.closed, 1)
    assert.equal(state.updates.length, 1)
    assert.equal(state.updates[0].status, 'falhou')
    assert.match(state.updates[0].mensagem_erro, /Código: 28P01\./)
    assert.doesNotMatch(JSON.stringify(state.updates), /secreto/)
    assert.equal(state.updates[0].total_lido, 0)
  } finally {
    delete globalThis.__pedidosConexaoJobTeste
    if(oldFlag===undefined)delete process.env.FRETE_LOGISTICA_SYNC_ATIVA
    else process.env.FRETE_LOGISTICA_SYNC_ATIVA=oldFlag
  }
})
