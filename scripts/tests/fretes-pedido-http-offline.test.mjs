import test from 'node:test'
import assert from 'node:assert/strict'
import {registerHooks} from 'node:module'
import express from 'express'

// Bloqueia os dois adaptadores reais antes do import da rota. Nenhum .env/SDK/pg.
const hooks = registerHooks({load(url, context, next) {
 if (url.endsWith('/src/lib/supabase-admin.server.js')) return {format:'module',shortCircuit:true,source:'export const supabase = new Proxy({}, {get(){throw Error("SDK real proibido no teste")}})'}
 if (url.endsWith('/src/lib/fretes/netvision.js')) return {format:'module',shortCircuit:true,source:'export async function lerLogisticaNetvision(){throw Error("Legado real proibido no teste") }'}
 return next(url, context)
}})
const {createFretesRouter} = await import('../../src/routes/fretes.js')
hooks.deregister()

const snapshot = {consultado_em:'2026-01-01T00:00:00Z',itens:[{
 CodigoItem:'sintetico',Quantidade:2,Unidade:'UN',UnidadeCadastro:'UN',
 PesoBruto:3,QtdeVolumeCubico:0.004,unidades:{peso:'kg',cubagem:'m3'},
}]}
const pedido = () => ({id:'pedido-sintetico',legacy_id:'001-42',status:'rascunho',
 total:10,qtde_volumes:1,cliente_erp_id:'cliente-sintetico',frete_logistica:structuredClone(snapshot)})

// Superfície somente SELECT: qualquer tabela/operação inesperada falha.
function banco(p, {erroItens=false, cadastro=false}={}) {
 const chamadas=[]
 return {chamadas, from(tabela) {
  assert.ok(['pedidos','clientes_erp','pedido_itens','produtos'].includes(tabela))
  const c={tabela,filtros:[]}; chamadas.push(c)
  return {
   select(campos){c.campos=campos;return this},
   eq(k,v){c.filtros.push([k,v]);return this},
   like(k,v){c.filtros.push([k,v]);return this},
   async limit(n){assert.ok(['pedidos','pedido_itens'].includes(tabela));c.limite=n;return tabela==='pedidos'?{data:[structuredClone(p)]}:
    erroItens?{error:Error('falha sintética')}:{data:cadastro?[{produto_id:'p',quantidade:2}]:[]}},
   async maybeSingle(){assert.equal(tabela,'clientes_erp');return {data:{razao_social:'Cliente sintético',endereco:{cep:'00000000',logradouro:'Rua de teste'}}}},
   async in(k,v){assert.equal(tabela,'produtos');c.filtros.push([k,v]);return {data:[{id:'p',legacy_id:'sintetico',logistica_fisica:{UnidadeCadastro:'UN',PesoBruto:4,QtdeVolumeCubico:0.005,unidades:{peso:'kg',cubagem:'m3'}}}]}},
  }
 }}
}

async function consultar(t,{flag, p=pedido(), role='admin', ...opcoes}={}) {
 const anterior=process.env.FRETE_NETVISION_LEITURA_DIRETA
 if(flag===undefined)delete process.env.FRETE_NETVISION_LEITURA_DIRETA
 else process.env.FRETE_NETVISION_LEITURA_DIRETA=flag
 t.after(()=>{if(anterior===undefined)delete process.env.FRETE_NETVISION_LEITURA_DIRETA;else process.env.FRETE_NETVISION_LEITURA_DIRETA=anterior})
 const db=banco(p,opcoes);let consultasLegado=0
 const app=express()
 // Testa autorização por papel real; autenticação JWT/mount global fora do escopo.
 app.use((req,res,next)=>{req.user={role};next()})
 app.use('/fretes',createFretesRouter(db,{loadLogistica:async()=>{consultasLegado++;throw Error('NetVision indisponível sintética')}}))
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))})
 t.after(()=>new Promise((resolve,reject)=>{server.close(e=>e?reject(e):resolve());server.closeAllConnections()}))
 const response=await fetch(`http://127.0.0.1:${server.address().port}/fretes/pedidos/42?filial=001`,{signal:AbortSignal.timeout(5000)})
 return {status:response.status,body:await response.json(),db,consultasLegado}
}

for(const flag of [undefined,'false']) test(`HTTP snapshot sem consulta ao legado: flag ${String(flag)}`,async t=>{
 const r=await consultar(t,{flag})
 assert.equal(r.status,200);assert.equal(r.consultasLegado,0)
 assert.equal(r.body.dados.peso_kg,6);assert.equal(r.body.dados.cubagem_m3,0.008)
 assert.equal(r.body.dados.entrega.nome,'Cliente sintético')
 assert.equal(r.body.dados.dados_importados_conferidos,false)
 assert.deepEqual(r.db.chamadas[0].filtros,[['sistema_origem','legado'],['legacy_id','001-42']])
 assert.equal(r.db.chamadas[0].limite,2)
})
test('HTTP sem catálogo nem snapshot exige carga manual, sem inventar totais',async t=>{
 const p=pedido();p.frete_logistica=null
 const r=await consultar(t,{p,flag:'false'})
 assert.equal(r.status,200);assert.equal(r.consultasLegado,0)
 assert.equal(r.body.dados.peso_kg,'');assert.equal(r.body.dados.cubagem_m3,'')
 assert.ok(r.body.avisos.some(a=>a.includes('manualmente')))
})
test('HTTP falha do catálogo mantém snapshot sem consultar legado desligado',async t=>{
 const r=await consultar(t,{flag:'false',erroItens:true})
 assert.equal(r.status,200);assert.equal(r.consultasLegado,0)
 assert.equal(r.body.dados.peso_kg,6)
 assert.ok(r.body.avisos.some(a=>a.includes('cadastro físico atual')))
})
test('HTTP cadastro físico local prevalece e dispensa legado mesmo opt-in',async t=>{
 const r=await consultar(t,{flag:'true',cadastro:true})
 assert.equal(r.status,200);assert.equal(r.consultasLegado,0)
 assert.equal(r.body.dados.peso_kg,8);assert.equal(r.body.dados.cubagem_m3,0.01)
})
test('HTTP leitura direta opt-in indisponível preserva snapshot e avisa',async t=>{
 const r=await consultar(t,{flag:'true'})
 assert.equal(r.status,200);assert.equal(r.consultasLegado,1)
 assert.equal(r.body.dados.peso_kg,6)
 assert.ok(r.body.avisos.some(a=>a.includes('Consulta direta')))
})
test('HTTP itens editados localmente não reaplicam snapshot nem consultam legado',async t=>{
 const p=pedido();p.campos_com_override_local=['itens']
 const r=await consultar(t,{p,flag:'true'})
 assert.equal(r.status,200);assert.equal(r.consultasLegado,0)
 assert.equal(r.body.dados.peso_kg,'');assert.equal(r.body.dados.cubagem_m3,'')
 assert.ok(r.body.avisos.some(a=>a.includes('Itens editados')))
})
test('HTTP vendedor não lê pedido pelo módulo de frete',async t=>{
 const r=await consultar(t,{role:'vendedor',flag:'false'})
 assert.equal(r.status,403);assert.equal(r.consultasLegado,0);assert.equal(r.db.chamadas.length,0)
})
