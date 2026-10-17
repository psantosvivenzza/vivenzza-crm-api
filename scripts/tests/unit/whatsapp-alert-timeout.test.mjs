import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import axios from 'axios'

const nomes=['EVOLUTION_API_URL','EVOLUTION_API_KEY','EVOLUTION_INSTANCE','WHATSAPP_REPORT_NUMBER','NO_PROXY','no_proxy']
const anteriores=new Map(nomes.map(k=>[k,process.env[k]]))
const adapterOriginal=axios.defaults.adapter
let sequencia=0
async function modulo(url='http://127.0.0.1:1') {
 process.env.EVOLUTION_API_URL=url
 process.env.EVOLUTION_API_KEY='chave-sintetica'
 process.env.EVOLUTION_INSTANCE='instancia-sintetica'
 process.env.WHATSAPP_REPORT_NUMBER='destinatario-sintetico'
 process.env.NO_PROXY='127.0.0.1';process.env.no_proxy='127.0.0.1'
 return import(`../../../src/lib/whatsappAlert.js?teste=${++sequencia}`)
}
test.afterEach(()=>{axios.defaults.adapter=adapterOriginal;for(const [k,v] of anteriores){if(v===undefined)delete process.env[k];else process.env[k]=v}})

test('alerta configura timeout finito e cancelamento sem alterar payload ou credenciais',async()=>{
 const {enviarAlertaWhatsapp}=await modulo()
 let chamadas=0
 axios.defaults.adapter=async config=>{
  chamadas++
  assert.equal(config.timeout,15000)
  assert.ok(config.signal instanceof AbortSignal)
  assert.equal(config.signal.aborted,false)
  assert.deepEqual(JSON.parse(config.data),{number:'destinatario-sintetico',text:'alerta sintético'})
  assert.equal(config.headers.apikey,'chave-sintetica')
  return {status:200,statusText:'OK',data:{},headers:{},config}
 }
 await enviarAlertaWhatsapp('alerta sintético')
 assert.equal(chamadas,1)
})

test('falha do transporte é propagada sem retry automático',async()=>{
 const {enviarAlertaWhatsapp}=await modulo()
 const erro=new Error('falha sintética');let chamadas=0
 axios.defaults.adapter=async()=>{chamadas++;throw erro}
 await assert.rejects(enviarAlertaWhatsapp('alerta sintético'),e=>e===erro)
 assert.equal(chamadas,1)
})

test('sem configuração não chama transporte',async()=>{
 const url='http://127.0.0.1:1'
 await modulo(url)
 delete process.env.EVOLUTION_INSTANCE
 const {enviarAlertaWhatsapp}=await import(`../../../src/lib/whatsappAlert.js?teste=${++sequencia}`)
 let chamadas=0
 axios.defaults.adapter=async()=>{chamadas++;throw Error('transporte proibido')}
 const warn=console.warn;console.warn=()=>{}
 try{await enviarAlertaWhatsapp('alerta sintético')}finally{console.warn=warn}
 assert.equal(chamadas,0)
})

test('HTTP local que aceita e nunca responde é cancelado, sem repetir envio',{timeout:22000},async t=>{
 let chamadas=0
 const server=http.createServer((req)=>{chamadas++;req.resume()})
 t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
 const {enviarAlertaWhatsapp}=await modulo(`http://127.0.0.1:${server.address().port}`)
 await assert.rejects(enviarAlertaWhatsapp('alerta sintético'),e=>['ERR_CANCELED','ECONNABORTED','ETIMEDOUT'].includes(e.code))
 assert.equal(chamadas,1)
})
