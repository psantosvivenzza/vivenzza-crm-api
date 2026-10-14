import http from 'node:http'
import express from 'express'
import assert from 'node:assert/strict'
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const actor=uid(1),seller=uid(2),other=uid(3),lead=uid(4)
const requests=[]
const fake=http.createServer(async(req,res)=>{
  let raw=''; for await(const chunk of req) raw+=chunk
  const url=new URL(req.url,'http://127.0.0.1')
  requests.push({url,body:raw?JSON.parse(raw):null})
  res.setHeader('Content-Type','application/json')
  res.setHeader('Content-Range','0-0/1')
  res.end(JSON.stringify(url.pathname.includes('/rpc/') ? {id:uid(8),alterado:true} : []))
})
await new Promise(resolve=>fake.listen(0,'127.0.0.1',resolve))
const upstream=`http://127.0.0.1:${fake.address().port}`
process.env.SUPABASE_URL=upstream
process.env.SUPABASE_SECRET_KEY='synthetic-not-a-real-key'
process.env.ANTHROPIC_API_KEY='synthetic-not-a-real-key'
process.env.EVOLUTION_API_URL=upstream
process.env.EVOLUTION_API_KEY='synthetic-not-a-real-key'
let server
// The imported SDR module starts a cache housekeeping interval. Track and
// clean up only timers created during this synthetic test's imports.
const originalSetInterval=globalThis.setInterval
const originalSetTimeout=globalThis.setTimeout
const importTimers=[]
const testTimeouts=[]
try {
  globalThis.setTimeout=(...args)=>{const timer=originalSetTimeout(...args);testTimeouts.push(timer);return timer}
  globalThis.setInterval=(...args)=>{const timer=originalSetInterval(...args);importTimers.push(timer);return timer}
  const [{default:whatsapp},{default:erp},{default:leads}]=await Promise.all([import('../../../src/routes/whatsapp.js'),import('../../../src/routes/erp.js'),import('../../../src/routes/leads.js')])
  globalThis.setInterval=originalSetInterval
  const app=express(); app.use(express.json())
  app.use((req,res,next)=>{req.user={id:req.headers['x-test-role']==='vendedor'?seller:actor,role:req.headers['x-test-role']||'admin'};next()})
  app.use('/whatsapp',whatsapp);app.use('/erp',erp)
  app.use('/leads',leads)
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve))
  const base=`http://127.0.0.1:${server.address().port}`
  const request=async(...args)=>{const response=await fetch(...args);await response.arrayBuffer();return response}
  const get=(path,role='admin')=>request(base+path,{headers:{'x-test-role':role}})
  assert.equal((await get('/leads?caixa=true&ordenacao=ultima_mensagem&page=1&limit=200&q=Antigo','vendedor')).status,200)
  assert.equal(requests.at(-1).url.pathname,'/rest/v1/rpc/listar_caixa_whatsapp')
  assert.equal(requests.at(-1).body.p_usuario_id,seller)
  assert.equal(requests.at(-1).body.p_responsavel_id,seller)
  assert.equal(requests.at(-1).body.p_busca,'Antigo')
  assert.equal(requests.at(-1).body.p_limite,200)
  assert.equal((await get('/leads?caixa=true&ordenacao=ultima_mensagem&page=2')).status,400)
  console.log('PASS HTTP: caixa usa snapshot SQL com busca global e carteira da sessão')
  assert.equal((await get('/whatsapp/retornos?limit=200&page=2')).status,200)
  assert.equal(requests.at(-1).url.searchParams.get('offset'),'200')
  assert.equal(requests.at(-1).url.searchParams.get('limit'),'200')
  assert.match(requests.at(-1).url.searchParams.get('select'),/leads!inner\(id,nome/)
  const size=requests.length
  assert.equal((await get('/whatsapp/retornos?responsavel_id='+other,'vendedor')).status,403)
  assert.equal(requests.length,size)
  assert.equal((await get('/whatsapp/retornos','vendedor')).status,200)
  assert.equal(requests.at(-1).url.searchParams.get('leads.responsavel_id'),'eq.'+seller)
  assert.equal((await get('/whatsapp/retornos','financeiro')).status,403)
  assert.equal((await get('/whatsapp/retornos?page=0')).status,400)
  console.log('PASS HTTP: paginação real do SDK, conversa vinculada e carteira protegida')
  const payload={request_id:uid(9),lead_id:lead,responsavel_id:seller,motivo:'Avaliar catálogo',prazo:new Date(Date.now()+86400000).toISOString(),p_usuario_id:other}
  const post=await request(base+'/whatsapp/retornos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
  assert.equal(post.status,201)
  assert.equal(requests.at(-1).body.p_usuario_id,actor)
  assert.equal(requests.at(-1).body.p_responsavel_id,seller)
  assert.equal((await request(base+`/erp/clientes/${uid(10)}/vendedor`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({vendedor_novo_id:other,motivo:'Reorganização',transferir_tarefas:true,p_usuario_id:seller})})).status,200)
  assert.equal(requests.at(-1).body.p_usuario_id,actor)
  assert.equal(requests.at(-1).body.p_transferir_tarefas,true)
  console.log('PASS HTTP: autor vem da sessão, não do corpo; responsável e opção de tarefas preservados')
} finally {
  globalThis.setInterval=originalSetInterval
  globalThis.setTimeout=originalSetTimeout
  for(const timer of importTimers) clearInterval(timer)
  for(const timer of testTimeouts) clearTimeout(timer)
  // Stop accepting connections before destroying keep-alive sockets, avoiding
  // a new pooled connection entering between destruction and close().
  if(server) await new Promise(r=>{server.close(r);server.closeAllConnections()})
  await new Promise(r=>{fake.close(r);fake.closeAllConnections()})
}
