import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import axios from 'axios'
import cron from 'node-cron'
import {supabase} from '../../src/lib/supabase-admin.server.js'
process.env.SDR_SITE_ENABLED='true'
process.env.SDR_SITE_INSTANCE='site-test'
process.env.EVOLUTION_WEBHOOK_TOKEN='test-only-webhook-token'
let scenario='unknown';let dbCalls=[];let sends=[];let rpcCalls=[]
axios.create=()=>({post:async(url,body)=>{sends.push({url,body});return {data:{key:{id:'test-id'}}}},get:async()=>({data:{}})})
supabase.from=(table)=>{dbCalls.push(table);const q=new Proxy({}, {get(_t,k){if(k==='then')return resolve=>resolve({data:table==='site_campaign_contacts'?(scenario==='unknown'?[]:[{id:'contact-id',lead_id:'lead-id',status:scenario==='blocked-stop'?'blocked':'sent'}]):[],error:null});return ()=>q}});return q}
supabase.rpc=(name,args)=>{rpcCalls.push({name,args});const q=new Proxy({}, {get(_t,k){if(k==='then')return resolve=>resolve({data:null,error:null});return ()=>q}});return q}
const originalSchedule=cron.schedule
cron.schedule=()=>({stop(){},destroy(){}})
const originalSetInterval=globalThis.setInterval
globalThis.setInterval=(...args)=>{const timer=originalSetInterval(...args);timer.unref();return timer}
const {default:router}=await import('../../src/routes/sdr.js')
globalThis.setInterval=originalSetInterval
cron.schedule=originalSchedule
const app=express();app.use(express.json());app.use('/api/sdr',router)
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
const url='http://127.0.0.1:'+server.address().port
const event=(text='Qual produto escolher?')=>({instance:'site-test',event:'messages.upsert',data:{key:{remoteJid:'5551999999999@s.whatsapp.net',fromMe:false,id:'inbound-test'},message:{conversation:text}}})
async function request(path,body,token='test-only-webhook-token'){const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json','x-webhook-token':token},body:JSON.stringify(body)});return {status:response.status,body:await response.json()}}
test('campaign endpoint rejects untrusted token',async()=>{const r=await request('/api/sdr/site-reativacao/webhook',event(),'bad-token');assert.equal(r.status,401)})
test('unknown contact cannot enter by sending twice',async()=>{scenario='unknown';dbCalls=[];sends=[];for(let i=0;i<2;i++)assert.equal((await request('/api/sdr/site-reativacao/webhook',event())).body.status,'ignored');assert.deepEqual(dbCalls,['site_campaign_contacts','site_campaign_contacts']);assert.equal(sends.length,0)})
test('old webhook cannot process dedicated instance',async()=>{dbCalls=[];assert.equal((await request('/api/sdr/webhook',event())).status,403);assert.equal(dbCalls.length,0)})
test('stop works even while AI config is unavailable and retries blocked contact',async()=>{scenario='blocked-stop';dbCalls=[];sends=[];rpcCalls=[];const r=await request('/api/sdr/site-reativacao/webhook',event('PARE'));assert.equal(r.body.status,'stopped');assert.equal(rpcCalls[0].name,'stop_site_campaign_contact');assert.equal(dbCalls.includes('automacoes_config'),false);assert.equal(sends[0].url,'/message/sendText/site-test')})
test.after(()=>{server.closeAllConnections();server.close()})
