import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

// CLI e job reais; nenhum SDK, driver, .env ou serviço real pode ser importado.
const entry = new URL('../../sync-pedidos-legado.mjs', import.meta.url).href
const job = new URL('../../../src/jobs/sync-pedidos-legado.js', import.meta.url).href
const helper = new URL('../../../src/lib/pedidos-conexao.js', import.meta.url).href

function executar(caso) {
  const bootstrap = `
import {registerHooks} from 'node:module';
import {writeSync} from 'node:fs';
const caso=${JSON.stringify(caso)};
const estado={queries:[],updates:[],insercoes:0,fechado:0,pools:0,logistica:0,filtro:null};
globalThis.__integracaoPedidos=estado;
estado.query=async(sql,params)=>{
 estado.queries.push(sql==='SELECT 1'?'probe':sql.includes('EN_Representantes')?'vendedores':'pedidos');
 if(sql==='SELECT 1'&&caso==='conexao')throw Object.assign(Error('segredo-sintetico'),{code:'28P01'});
 if(sql==='SELECT 1'||sql.includes('EN_Representantes'))return {rows:[]};
 if(sql.includes('FROM "ES_Pedidos"')){estado.params=params;return {rows:caso==='parcial'?[{CodigoFilial:'TESTE',NumeroPedido:1,DataAtualizacao:'2026-01-02T00:00:00Z'}]:[]}};
 throw Error('consulta fora do contrato');
};
estado.from=tabela=>{
 let acao='select',payload;
 const q={select(){return q},not(){return q},order(){return q},limit(){return q},range(){return q},
 eq(k,v){if(tabela==='sincronizacoes_pedidos'&&k==='status')estado.filtro=v;return q},
 insert(v){acao='insert';payload=v;estado.insercoes++;return q},update(v){acao='update';payload=v;return q},
 async maybeSingle(){if(tabela==='pedidos'&&caso==='parcial')return {data:null,error:Error('linha sintetica recusada')};
 if(tabela!=='sincronizacoes_pedidos')throw Error('tabela inesperada');
 return {data:estado.filtro==='concluido'?{cursor_final:'2026-01-01T00:00:00Z'}:{cursor_final:'2026-01-03T00:00:00Z'},
 error:caso==='historico'?Error('historico sintetico indisponivel'):null}},
 async single(){return {data:{id:'sync-sintetica'},error:null}},
 then(resolve,reject){
  let error=null;
  if(acao==='update'){estado.updates.push(payload);if(caso==='persistencia'&&payload.status==='concluido')error=Error('persistencia sintetica indisponivel')};
  return Promise.resolve({data:[],error}).then(resolve,reject)
 }};
 if(!['sincronizacoes_pedidos','clientes_erp','produtos','usuarios',...(caso==='parcial'?['pedidos','sincronizacao_pedidos_erros']:[])].includes(tabela))throw Error('tabela fora do contrato');
 return q;
};
const ref='globalThis.__integracaoPedidos';
const stubs=new Map([
 ['dotenv/config','export {}'],
 ['pg','export default {Pool:class {constructor(){'+ref+'.pools++} async query(sql,params){return '+ref+'.query(sql,params)} async end(){'+ref+'.fechado++}}}'],
 ['../lib/supabase-admin.server.js','export const supabase={from:t=>'+ref+'.from(t)}'],
 ['../lib/e01Host.js','export async function configE01(){return {}}'],
 ['../lib/fretes/netvision.js','export async function lerLogisticaNetvision(){'+ref+'.logistica++;throw Error("logistica proibida")}'],
 ['./sync-logistica-produtos.js','export async function sincronizarLogisticaProdutos(){'+ref+'.logistica++;throw Error("logistica proibida")}'],
]);
const permitidos=new Set(${JSON.stringify([entry, job, helper])});
registerHooks({resolve(specifier,context,next){
 if(stubs.has(specifier))return {url:'data:text/javascript,'+encodeURIComponent(stubs.get(specifier)),shortCircuit:true};
 let url;try{url=new URL(specifier,context.parentURL).href}catch{throw Error('import proibido')};
 if(permitidos.has(url))return next(specifier,context);
 throw Error('import proibido');
}});
process.on('exit',()=>writeSync(1,'\\nESTADO_SINTETICO='+JSON.stringify(estado)+'\\n'));
await import(${JSON.stringify(entry)});
`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', bootstrap], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot || '', FRETE_LOGISTICA_SYNC_ATIVA: 'false' },
  })
  assert.ifError(r.error)
  assert.equal(r.signal, null)
  const linha = r.stdout.split(/\r?\n/).find(l => l.startsWith('ESTADO_SINTETICO='))
  assert.ok(linha, r.stderr)
  const estado = JSON.parse(linha.slice('ESTADO_SINTETICO='.length))
  assert.equal(estado.logistica, 0, 'nenhuma chamada logística, mesmo se o job engolir a exceção')
  return { ...r, estado }
}

test('CLI + job: conexão rejeitada sai com erro sanitizado e fecha o pool', () => {
  const r = executar('conexao')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Código: 28P01\./)
  assert.doesNotMatch(r.stderr + r.stdout, /segredo-sintetico/)
  assert.deepEqual(r.estado.queries, ['probe'])
  assert.equal(r.estado.fechado, 1)
  assert.equal(r.estado.updates.at(-1).status, 'falhou')
  assert.match(r.estado.updates.at(-1).mensagem_erro, /Código: 28P01\./)
  assert.doesNotMatch(JSON.stringify(r.estado), /segredo-sintetico/)
})

test('CLI + job: falha no histórico aborta sem conectar nem criar ciclo', () => {
  const r = executar('historico')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /historico sintetico indisponivel/)
  assert.equal(r.estado.insercoes, 0)
  assert.deepEqual(r.estado.queries, [])
  assert.equal(r.estado.pools, 0)
  assert.equal(r.estado.fechado, 0)
  assert.deepEqual(r.estado.updates, [])
})

test('CLI + job: persistência final recusada não vira sucesso no agendador', () => {
  const r = executar('persistencia')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /persistencia sintetica indisponivel/)
  assert.equal(r.estado.updates.at(-1).status, 'falhou')
  assert.equal(r.estado.fechado, 1)
})

test('CLI + job: ciclo vazio usa somente checkpoint concluído e sai zero', () => {
  const r = executar('limpo')
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.estado.filtro, 'concluido')
  assert.deepEqual(r.estado.params, ['2025-12-31T23:50:00.000Z'])
  assert.equal(r.estado.updates.at(-1).cursor_final, '2026-01-01T00:00:00.000Z')
  assert.equal(r.estado.updates.at(-1).status, 'concluido')
  assert.equal(r.estado.fechado, 1)
})

test('CLI + job: linha recusada produz resultado parcial e saída de erro', () => {
  const r = executar('parcial')
  assert.equal(r.status, 1, r.stderr)
  const linha = r.stdout.split(/\r?\n/).find(l => l.startsWith('[sync-pedidos-legado]'))
  assert.ok(linha)
  const relatorio = JSON.parse(linha.slice(linha.indexOf('{')))
  assert.equal(relatorio.status, 'concluido_com_erros')
  assert.equal(relatorio.total_com_erro, 1)
  assert.equal(relatorio.total_lido, 1)
  assert.equal(r.estado.updates.at(-1).status, 'concluido_com_erros')
  assert.equal(r.estado.updates.at(-1).cursor_final, '2026-01-01T00:00:00.000Z')
  assert.equal(r.estado.fechado, 1)
})
