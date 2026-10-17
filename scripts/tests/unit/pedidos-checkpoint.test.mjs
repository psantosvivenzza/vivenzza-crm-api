import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'

let estado
const referencia = 'globalThis.__pedidosCheckpointTeste'
const modulos = new Map([
 ['pg', `export default {Pool: class {async query(sql,params){return ${referencia}.query(sql,params)} async end(){${referencia}.fechado=true}}}`],
 ['../lib/supabase-admin.server.js', `export const supabase={from:t=>${referencia}.from(t)}`],
 ['../lib/e01Host.js', 'export async function configE01(){return {}}'],
 ['../lib/fretes/netvision.js', 'export async function lerLogisticaNetvision(){throw Error("logística proibida no teste")}'],
 ['./sync-logistica-produtos.js', 'export async function sincronizarLogisticaProdutos(){throw Error("sync físico proibido no teste")}'],
])
// Intercepta antes do import: não carrega pg, SDK, dotenv ou configuração real.
const hooks = registerHooks({resolve(specifier, context, next) {
 if(modulos.has(specifier))return {url: `data:text/javascript,${encodeURIComponent(modulos.get(specifier))}`,shortCircuit:true}
 if(specifier.startsWith('node:') || specifier.endsWith('/src/jobs/sync-pedidos-legado.js'))return next(specifier,context)
 throw Error(`Import não permitido no teste: ${specifier}`)
}})
const {executarSincronizacaoPedidos} = await import('../../../src/jobs/sync-pedidos-legado.js')
hooks.deregister()

function preparar({historico=[],erroHistorico=null,erroFinal=null,erroDetalhes=null,falharPedido=false,sucessoPosterior=false}={}) {
 estado = {insercoes:0,conexoes:0,fechado:false,updates:[],params:[],historico,erroHistorico,erroFinal,erroDetalhes,falharPedido}
 estado.query = async (sql, params) => {
  if(sql==='SELECT 1'){estado.conexoes++;return {rows:[]}}
  if(sql.includes('EN_Representantes'))return {rows:[]}
  if(sql.includes('FROM "ES_Pedidos"')){estado.params.push(params);return {rows: falharPedido ? [
   {CodigoFilial:'TESTE',NumeroPedido:1,DataAtualizacao:'2026-01-02T00:00:00Z'},
   ...(sucessoPosterior?[{CodigoFilial:'TESTE',NumeroPedido:2,StatusPedido:0,DataAtualizacao:'2026-01-03T00:00:00Z'}]:[]),
  ] : []}}
  throw Error('Consulta não prevista no double')
 }
 estado.from = tabela => {
  const filtros = {};let acao='select',payload
  const q = {
   select(){return q},not(){return q},order(campo,opcoes){estado.ordenacao=[campo,opcoes];return q},limit(){return q},range(){return q},
   eq(k,v){filtros[k]=[v];return q},in(k,v){filtros[k]=v;return q},
   insert(v){acao='insert';payload=v;estado.insercoes++;return q},
   update(v){acao='update';payload=v;return q},
   async single(){assert.equal(tabela,'sincronizacoes_pedidos');return {data:{id:'sync-sintetica'},error:null}},
   async maybeSingle(){
    if(tabela==='pedidos')return filtros.legacy_id?.[0]==='TESTE-2'
     ? {data:{id:'pedido-sintetico',atualizado_localmente_em:'2026-01-01',campos_com_override_local:['itens']},error:null}
     : {data:null,error:new Error('pedido sintético falhou')}
    assert.equal(tabela,'sincronizacoes_pedidos')
    const elegiveis=historico.filter(h=>filtros.status?.includes(h.status))
    return {data:elegiveis[0]??null,error:erroHistorico}
   },
   then(resolve,reject){
    let resultado={data:[],error:null}
    if(acao==='update'&&tabela==='sincronizacoes_pedidos') {estado.updates.push(payload);resultado.error=payload.status==='falhou'?null:erroFinal}
    if(acao==='insert'&&tabela==='sincronizacao_pedidos_erros')resultado.error=erroDetalhes
    return Promise.resolve(resultado).then(resolve,reject)
   },
  }
  return q
 }
 globalThis.__pedidosCheckpointTeste=estado
}
const completo={status:'concluido',cursor_final:'2026-01-01T00:00:00Z'}
const parcial={status:'concluido_com_erros',cursor_final:'2026-01-03T00:00:00Z'}
const flagAnterior=process.env.FRETE_LOGISTICA_SYNC_ATIVA
test.beforeEach(()=>{process.env.FRETE_LOGISTICA_SYNC_ATIVA='false'})
test.after(()=>{if(flagAnterior===undefined)delete process.env.FRETE_LOGISTICA_SYNC_ATIVA;else process.env.FRETE_LOGISTICA_SYNC_ATIVA=flagAnterior;delete globalThis.__pedidosCheckpointTeste})

test('checkpoint ignora execução parcial mais recente e mantém janela do último sucesso', async()=>{
 preparar({historico:[parcial,completo]})
 await executarSincronizacaoPedidos()
 assert.deepEqual(estado.params[0],['2025-12-31T23:50:00.000Z'])
 assert.deepEqual(estado.ordenacao,['concluido_em',{ascending:false}])
 assert.equal(estado.fechado,true)
})
test('somente histórico parcial exige backfill em vez de avançar sobre falhas',async()=>{
 preparar({historico:[parcial]})
 await executarSincronizacaoPedidos()
 assert.deepEqual(estado.params[0],[])
})
test('erro de leitura do checkpoint aborta antes de criar ciclo ou conectar origem',async()=>{
 const erro=new Error('histórico sintético indisponível');preparar({erroHistorico:erro})
 await assert.rejects(executarSincronizacaoPedidos(),e=>e===erro)
 assert.equal(estado.insercoes,0);assert.equal(estado.conexoes,0)
})
test('falha ao persistir conclusão não é relatada como sucesso',async()=>{
 const erro=new Error('conclusão sintética indisponível');preparar({erroFinal:erro})
 await assert.rejects(executarSincronizacaoPedidos(),e=>e===erro)
 assert.equal(estado.updates.at(-1).status,'falhou');assert.equal(estado.fechado,true)
})
test('falha ao registrar detalhes do erro não é ocultada',async()=>{
 const erro=new Error('detalhes sintéticos indisponíveis');preparar({falharPedido:true,erroDetalhes:erro})
 await assert.rejects(executarSincronizacaoPedidos(),e=>e===erro)
 assert.equal(estado.updates.at(-1).status,'falhou');assert.equal(estado.fechado,true)
})
test('erro individual continua visível como parcial e preserva fechamento do pool',async()=>{
 preparar({falharPedido:true})
 const r=await executarSincronizacaoPedidos()
 assert.equal(r.status,'concluido_com_erros');assert.equal(r.total_com_erro,1)
 assert.equal(estado.fechado,true)
})

test('sucesso depois de falha não permite que o próximo ciclo pule a linha antiga',async()=>{
 preparar({historico:[completo],falharPedido:true,sucessoPosterior:true})
 const primeiro=await executarSincronizacaoPedidos()
 assert.equal(primeiro.total_atualizado,1)
 assert.equal(primeiro.total_com_erro,1)
 assert.equal(primeiro.cursor_final,'2026-01-03T00:00:00.000Z')
 assert.equal(primeiro.status,'concluido_com_erros')
 preparar({historico:[primeiro,completo]})
 await executarSincronizacaoPedidos()
 assert.deepEqual(estado.params[0],['2025-12-31T23:50:00.000Z'])
})

test('ciclo limpo persiste e retorna conclusão com erro zero',async()=>{
 preparar({historico:[completo]})
 const r=await executarSincronizacaoPedidos()
 assert.equal(r.status,'concluido');assert.equal(r.total_com_erro,0)
 assert.equal(estado.updates.at(-1).status,'concluido')
 assert.equal(estado.fechado,true)
})

test('ciclo sem novidades não recua o checkpoint pela janela de segurança',async()=>{
 preparar({historico:[completo]})
 const r=await executarSincronizacaoPedidos()
 assert.equal(r.cursor_final,'2026-01-01T00:00:00.000Z')
 assert.equal(estado.updates.at(-1).cursor_final,'2026-01-01T00:00:00.000Z')
})
