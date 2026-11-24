import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import {aplicarFiltrosPedidos} from '../../src/lib/pedidosFiltros.js'
const rows=[
 {id:'a',status:'faturado',total:100,criado_em:'2026-11-24T03:00:00.000Z',vendedor_id:'seller',sistema_origem:'legado'},
 {id:'b',status:'confirmado',total:50,criado_em:'2026-11-25T02:59:59.999Z',vendedor_id:'seller',sistema_origem:'legado'},
 {id:'c',status:'faturado',total:200,criado_em:'2026-11-25T03:00:00.000Z',vendedor_id:'seller',sistema_origem:'legado'},
 {id:'d',status:'faturado',total:400,criado_em:'2026-11-24T02:59:59.999Z',vendedor_id:'other',sistema_origem:'crm'},
 {id:'e',status:'cancelado',total:700,criado_em:'2026-11-24T12:00:00.000Z',vendedor_id:'other',sistema_origem:'crm'},
]
function query(){let filters=[],head=false,single=false,range=[0,9999];const q={select(s,o={}){head=o.head;return q},eq(k,v){filters.push(r=>r[k]===v);return q},gte(k,v){filters.push(r=>r[k]>=v);return q},lt(k,v){filters.push(r=>r[k]<v);return q},lte(k,v){filters.push(r=>r[k]<=v);return q},not(k,op,v){filters.push(r=>op==='in'?!v.slice(1,-1).split(',').includes(r[k]):r[k]!=null);return q},order(){return q},range(a,b){range=[a,b];return q},then(resolve,reject){const data=rows.filter(r=>filters.every(f=>f(r)));return Promise.resolve({data:head?null:data.slice(range[0],range[1]+1),count:data.length,error:null}).then(resolve,reject)}};return q}
async function handlers(){const source=await readFile(new URL('../../src/routes/pedidos.js',import.meta.url),'utf8');const functions={};const router={get:(path,fn)=>{functions[path]=fn}};const start=source.indexOf("router.get('/',"),end=source.indexOf('// GET /api/pedidos/:id — detalhe',start);assert.ok(start>=0&&end>start,'Real pedidos handlers must be located');vm.runInNewContext(source.slice(start,end),{router,supabase:{from:()=>query()},aplicarFiltrosPedidos,ORDENACOES:{recentes:{coluna:'criado_em',ascending:false}},SELECT_PEDIDO_LISTA:'*',STATUS_VALIDOS:['rascunho','confirmado','faturado','entregue','cancelado'],Date,console});return functions}
const response=()=>({code:200,status(n){this.code=n;return this},json(data){this.body=data}})
const day={periodo_de:'2026-11-24',periodo_ate:'2026-11-24'}
test('real list and summary share period, full final day, origin and forced seller scope',async()=>{const h=await handlers();for(const params of [day,{...day,sistema_origem:'legado'},{...day,status:'faturado'},{...day,vendedor_id:'other'}]){const req={query:params,user:{role:'vendedor',id:'seller'}},list=response(),summary=response();await h['/'](req,list);await h['/resumo'](req,summary);assert.equal(list.code,200);assert.equal(summary.code,200);assert.equal(summary.body.total_pedidos,list.body.data.length);assert.equal(summary.body.valor_total,list.body.data.filter(x=>!['rascunho','cancelado'].includes(x.status)).reduce((s,x)=>s+x.total,0));assert.ok(list.body.data.every(x=>x.vendedor_id==='seller'));assert.ok(!list.body.data.some(x=>['c','d'].includes(x.id)))}})
test('final date includes last evening and excludes next day; invalid and inverted dates are rejected',async()=>{const data=await aplicarFiltrosPedidos(query(),day,{role:'admin'});assert.deepEqual(data.data.map(x=>x.id),['a','b','e']);for(const params of [{periodo_de:'2026-02-30'},{periodo_ate:'invalid'},{periodo_de:'2026-11-25',periodo_ate:'2026-11-24'}]){assert.throws(()=>aplicarFiltrosPedidos(query(),params,{}),e=>e.status===400)}})
test('operational filters are identical and importados_hoje uses Brasilia calendar',()=>{const calls=[],q={eq(...a){calls.push(['eq',...a]);return q},not(...a){calls.push(['not',...a]);return q},gte(...a){calls.push(['gte',...a]);return q}};aplicarFiltrosPedidos(q,{sem_vinculo:'true',com_erro:'true',com_conflito:'true',importados_hoje:'true'},{role:'admin'},new Date('2026-11-25T01:00:00Z'));assert.ok(calls.some(c=>c[1]==='sincronizado_em'&&c[2]==='2026-11-24T03:00:00.000Z'));assert.equal(calls.length,4)})

test('legacy explicit timestamp ranges keep their exact inclusive upper bound',async()=>{const data=await aplicarFiltrosPedidos(query(),{periodo_de:'2026-11-24T03:00:00Z',periodo_ate:'2026-11-24T03:00:00Z'},{});assert.deepEqual(data.data.map(r=>r.id),['a'])})

