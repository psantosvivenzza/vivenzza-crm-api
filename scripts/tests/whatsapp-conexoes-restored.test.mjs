import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {auth} from '../../src/middleware/auth.js'
import {createFzapConnectionsRouter} from '../../src/routes/whatsapp-conexoes.js'
import {createFzapConnectionsService} from '../../src/lib/fzapConnections.js'

test('entrypoint registers connections after auth without removing Lara coach',()=>{
 const source=readFileSync(new URL('../../src/index.js',import.meta.url),'utf8')
 assert.match(source,/app\.use\('\/api\/whatsapp-conexoes', auth, whatsappConexoesRouter\)/)
 assert.match(source,/app\.use\('\/api\/lara', auth, laraCoachRouter\)/)
})

test('list degrades per connection and never mutates sessions or leaks secrets',async()=>{
 const connections=['online','offline','unavailable'].map(id=>({id,nome:id,instanceName:id,finalidade:'comercial',token:'test-secret'}))
 const writes=[]
 const service=createFzapConnectionsService({
  getConfig:()=>({baseURL:'https://fixture.invalid',connections}),
  ownershipStore:{get:async id=>({owner:'fzap',migrationRequested:false,instanceName:id,finalidade:'comercial'})},
  transport:async ({path,method,token})=>{
   if(method!=='GET'||path!=='/session/status')writes.push(method)
   const id=connections.find(c=>c.token===token)?.id
   // Distinct identity assigned through token below.
   if(id==='unavailable')throw Error('upstream fixture')
   return {code:200,success:true,data:{connected:id==='online',loggedIn:id==='online',jid:'5500000000000@s.whatsapp.net',metadata:{vivenzza_crm_instance_name:id,vivenzza_crm_transport:'fzap',vivenzza_crm_connection_id:id,vivenzza_crm_finalidade:'comercial',vivenzza_crm_expected_jid_sha256:createHash('sha256').update('5500000000000').digest('hex')}}}
  },
 })
 connections.forEach(c=>{c.token=c.id})
 const result=await service.list()
 assert.deepEqual(result.conexoes.map(x=>x.estado),['conectado','desconectado','indeterminado'])
 assert.deepEqual(writes,[])
 assert.ok(result.conexoes.every(c=>!Object.hasOwn(c,'token')))
})

test('HTTP anonymous denied, other admin denied, designated admin receives no-cache list',async()=>{
 const original=process.env.JWT_SECRET;process.env.JWT_SECRET='offline-test-secret-only'
 const app=express();let reads=0
 app.use('/api/whatsapp-conexoes',auth,createFzapConnectionsRouter({service:{list:async()=>{reads++;return {configurado:true,provedor:'fzap',conexoes:[]}}}}))
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
 const url=`http://127.0.0.1:${server.address().port}/api/whatsapp-conexoes`
 try{
  assert.equal((await fetch(url)).status,401)
  for(const [user,status] of [[{email:'other@example.test',role:'admin'},403],[{email:'psantos@vivenzzaprofessional.com.br',role:'vendedor'},403],[{email:'psantos@vivenzzaprofessional.com.br',role:'admin'},200]]){
   const r=await fetch(url,{headers:{authorization:'Bearer '+jwt.sign(user,process.env.JWT_SECRET,{expiresIn:60})}})
   assert.equal(r.status,status)
   if(status===200){assert.match(r.headers.get('cache-control'),/no-store/);assert.equal((await r.json()).configurado,true)}
  }
  assert.equal(reads,1)
 }finally{await new Promise(r=>server.close(r));if(original===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=original}
})
