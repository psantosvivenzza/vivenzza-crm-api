// HTTP real em loopback; banco simulado e proibicao explicita de escrita.
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { setTimeout as delay } from 'node:timers/promises'
process.env.NODE_ENV='test'
process.env.LOCAL_PG_URL='postgres://test:test@127.0.0.1:1/test'
const { createFretesRouter }=await import('../../src/routes/fretes.js')
const id='11111111-1111-4111-8111-111111111111', qid='22222222-2222-4222-8222-222222222222'

function fixture({ fail, empty=false, reject:rejectQuery=false }={}) {
 const tables={
  frete_cotacoes:{id,status:'aberta',dados:{}},
  frete_consultas:empty?[]:[{id:qid,cotacao_id:id,nome_transportadora:'Sintetica',telefone:'5551999999999',completa:false}],
  frete_envios:[{id:'send-test',consulta_id:qid,status:'enviado'}],
  frete_mensagens:[{id:'new',consulta_id:qid,texto:'Novo'},{id:'old',consulta_id:qid,texto:'Antigo'}],
  frete_anexos:[{mensagem_id:'new',status:'pendente',mimetype:'image/png'}],
  frete_respostas_pendentes:[{id:'pending',telefone:'5551999999999',texto:'Sem referencia'}]
 }
 let active=0, peak=0
 const reads=[],calls={}
 const db={from(table){
  assert.ok(Object.hasOwn(tables,table))
  const query={}
  calls[table]=[]
  for(const method of ['select','eq','in','order','limit','is','maybeSingle'])query[method]=(...args)=>{calls[table].push([method,...args]);return query}
  query.then=(resolve,reject)=>{
   reads.push(table);active++;peak=Math.max(peak,active)
   return delay(10).then(()=>{active--;if(table===fail && rejectQuery)throw new Error('SYNTHETIC_REJECTION');return table===fail?{data:null,error:{code:'SYNTHETIC_READ_ERROR'}}:{data:structuredClone(tables[table]),error:null}}).then(resolve,reject)
  }
  return query
 }}
 return {db,reads,calls,get peak(){return peak}}
}
async function request(f,role='financeiro') {
 const app=express()
 app.use((req,_res,next)=>{req.user={id:'synthetic',role};next()})
 app.use('/api/fretes',createFretesRouter(f.db))
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))})
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/api/fretes/${id}`);return{status:r.status,data:await r.json()}}
 finally{await new Promise(resolve=>server.close(resolve))}
}
test('detalhe nao serializa quatro leituras independentes e preserva contrato',async()=>{
 const f=fixture(),r=await request(f)
 assert.equal(r.status,200)
 assert.equal(f.peak,4,'Envios, mensagens, anexos e pendentes devem executar no mesmo estagio de leitura')
 assert.deepEqual(f.reads.slice(0,2),['frete_cotacoes','frete_consultas'])
 assert.equal(r.data.cotacao.id,id)
 assert.deepEqual(r.data.consultas[0].mensagens.map(m=>m.id),['old','new'])
 assert.equal(r.data.consultas[0].mensagens[1].anexo.status,'pendente')
 assert.equal(r.data.consultas[0].respostas_pendentes[0].id,'pending')
 assert.equal(r.data.consultas[0].envios[0].id,'send-test')
 assert.deepEqual(f.calls.frete_envios,[['select','id,consulta_id,status,error_code,created_at,attempted_at'],['in','consulta_id',[qid]],['order','created_at',{ascending:false}],['limit',200]])
 assert.deepEqual(f.calls.frete_mensagens,[['select','*'],['eq','cotacao_id',id],['order','created_at',{ascending:false}],['limit',500]])
 assert.deepEqual(f.calls.frete_anexos,[['select','mensagem_id,status,mimetype'],['eq','cotacao_id',id]])
 assert.ok(f.calls.frete_respostas_pendentes.some(c=>c[0]==='is'&&c[1]==='consulta_id'&&c[2]===null))
 assert.ok(f.calls.frete_respostas_pendentes.some(c=>c[0]==='eq'&&c[1]==='instance_name'&&c[2]==='vivenzza-financeiro'))
 assert.ok(f.calls.frete_respostas_pendentes.some(c=>c[0]==='limit'&&c[1]===100))
})
for(const fail of ['frete_envios','frete_mensagens','frete_anexos','frete_respostas_pendentes'])test(`falha em ${fail} retorna 503 sem detalhe parcial`,async()=>{
 const r=await request(fixture({fail}))
 assert.equal(r.status,503);assert.ok(r.data.erro);assert.equal(r.data.consultas,undefined)
})
test('rejeicao de promise tambem retorna 503 sem detalhe parcial',async()=>{
 const r=await request(fixture({fail:'frete_envios',reject:true}))
 assert.equal(r.status,503);assert.equal(r.data.consultas,undefined)
})
test('papel sem permissao nao inicia leituras',async()=>{
 const f=fixture(),r=await request(f,'vendedor')
 assert.equal(r.status,403);assert.equal(f.reads.length,0)
})
test('cotacao sem consultas preserva resposta vazia',async()=>{
 const f=fixture({empty:true}),r=await request(f)
 assert.equal(r.status,200);assert.deepEqual(r.data.consultas,[])
 assert.ok(!f.reads.includes('frete_respostas_pendentes'))
})
