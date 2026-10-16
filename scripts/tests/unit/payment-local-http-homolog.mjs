// Existing financeiro Router + real auth + real job + local PostgreSQL.
// Never import src/index.js, .env or an external provider bootstrap.
import http from 'node:http'
import assert from 'node:assert/strict'
import {randomBytes,randomUUID} from 'node:crypto'

export async function runHttpHomologation({workspace,fixture,q,check,setHttpPort}) {
  const [{default:express},{default:jwt}]=await Promise.all([import('express'),import('jsonwebtoken')])
  // Ephemeral synthetic secret in this test process only; no existing secret read.
  process.env.JWT_SECRET=randomBytes(32).toString('hex')
  delete process.env.API_SECRET_KEY
  const {auth}=await import('../../../src/middleware/auth.js')
  const {default:financeiroRouter}=await import('../../../src/routes/financeiro.js')
  const {runPaymentReconciliationSweep}=await import('../../../src/jobs/payment-reconciliation-sweep.js')
  const {hojeBrtISO}=await import('../../../src/lib/collection/collectionContactPolicy.js')
  const date=new Date(hojeBrtISO()+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+1)
  const promised=date.toISOString().slice(0,10)
  const token=role=>jwt.sign({id:randomUUID(),role},process.env.JWT_SECRET,{expiresIn:'5m'})
  const tokens={admin:token('admin'),financeiro:token('financeiro'),vendedor:token('vendedor'),unknown:token('UNKNOWN')}
  const app=express();app.use(express.json())
  // Exact mount used by production index, without loading that index or its crons.
  app.use('/api/financeiro',auth,financeiroRouter)
  const server=http.createServer(app)
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const port=server.address().port;setHttpPort(port)
  const request=(method,url,body,role='admin')=>new Promise((resolve,reject)=>{
    const headers={'Content-Type':'application/json'}
    if(role)headers.Authorization='Bearer '+(tokens[role]??'SYNTHETIC_INVALID_TOKEN')
    const r=http.request({host:'127.0.0.1',port,method,path:url,headers,agent:false},res=>{
      let raw='';res.setEncoding('utf8');res.on('data',c=>{raw+=c});res.on('end',()=>{
        try{resolve({status:res.statusCode,body:JSON.parse(raw)})}catch(e){reject(e)}
      })
    })
    r.setTimeout(5000,()=>r.destroy(Error('Synthetic HTTP timeout')));r.once('error',reject)
    r.end(body===undefined?undefined:JSON.stringify(body))
  })
  let primary
  try {
    await check('HTTP actual auth and financial write allowlist reject unauthorized callers',async()=>{
      const f=await fixture({pago:'0',status:'aberta',promise:false})
      const url='/api/financeiro/'+f.id+'/promessa',body={data_prometida:promised}
      assert.equal((await request('POST',url,body,null)).status,401)
      assert.equal((await request('POST',url,body,'invalid')).status,401)
      for(const role of ['vendedor','unknown'])assert.equal((await request('POST',url,body,role)).status,403)
      assert.equal(Number((await q('SELECT count(*) AS n FROM public.collection_promises WHERE contas_financeiras_id=$1',[f.id])).rows[0].n),0)
      return {auth:'real JWT middleware',denied:[401,401,403,403],mutations:0}
    })
    await check('HTTP creates real promise, rejects invalid date and duplicate without extra rows',async()=>{
      primary=await fixture({pago:'0',status:'aberta',promise:false})
      const url='/api/financeiro/'+primary.id+'/promessa'
      assert.equal((await request('POST',url,{data_prometida:'INVALID'},'financeiro')).status,400)
      const created=await request('POST',url,{data_prometida:promised,observacao:'SYNTHETIC LOCAL ACCEPTANCE'},'financeiro')
      assert.equal(created.status,201);assert.equal(created.body.promessa.status,'ativa')
      primary.pid=created.body.promessa.id
      const read=await request('GET',url);assert.equal(read.status,200);assert.equal(read.body.promessa.id,primary.pid)
      assert.equal((await request('POST',url,{data_prometida:promised})).status,409)
      assert.equal(Number((await q('SELECT count(*) AS n FROM public.collection_promises WHERE contas_financeiras_id=$1',[primary.id])).rows[0].n),1)
    })
    await check('HTTP promise -> synthetic payment fixture -> actual job/RPC -> HTTP sanitized ordered timeline',async()=>{
      assert(primary?.pid,'Promise fixture must be created through HTTP first')
      // Only this labeled synthetic account; never a real financial mutation.
      await q("UPDATE public.contas_financeiras SET valor_pago=valor,status='paga' WHERE id=$1",[primary.id])
      await runPaymentReconciliationSweep()
      const read=await request('GET','/api/financeiro/'+primary.id+'/promessa')
      assert.equal(read.status,200);assert.equal(read.body.promessa,null)
      const timeline=await request('GET','/api/financeiro/'+primary.id+'/timeline')
      assert.equal(timeline.status,200);assert.equal(timeline.body.total,3)
      assert.deepEqual(timeline.body.eventos.map(e=>e.tipo),['PROMESSA_PAGAMENTO','PROMESSA_CUMPRIDA','PAGO'])
      const [created,fulfilled,paid]=timeline.body.eventos
      assert.equal(created.origem,'HUMAN');assert.equal(fulfilled.origem,'PAYMENT_RECONCILIATION');assert.equal(paid.origem,'PAYMENT_RECONCILIATION')
      assert.equal(paid.metadata.promessaCumprida,true);assert.equal(paid.metadata.dispatches,1)
      assert(timeline.body.eventos.every(e=>!('dados'in e)&&!('promise_id'in e.metadata)))
      const order=(await q("SELECT a.criado_em < b.criado_em AS ordered FROM public.collection_timeline_events a JOIN public.collection_timeline_events b ON a.contas_financeiras_id=b.contas_financeiras_id WHERE a.contas_financeiras_id=$1 AND a.tipo='PROMESSA_CUMPRIDA' AND b.tipo='PAGO'",[primary.id])).rows[0]
      assert.equal(order.ordered,true)
      const page=await request('GET','/api/financeiro/'+primary.id+'/timeline?page=3&limit=1')
      assert.equal(page.body.eventos.length,1);assert.equal(page.body.eventos[0].tipo,'PAGO')
      await runPaymentReconciliationSweep()
      assert.equal((await request('GET','/api/financeiro/'+primary.id+'/timeline')).body.total,3)
      return {httpEvents:3,rawDataExposed:false,repeatDuplicates:0,job:'real exported function; no scheduler started'}
    })
    await check('HTTP reads prove full rollback after job failure and next-run recovery',async()=>{
      const f=await fixture({pago:'0',status:'aberta',promise:false})
      assert.equal((await request('POST','/api/financeiro/'+f.id+'/promessa',{data_prometida:promised})).status,201)
      await q("UPDATE public.contas_financeiras SET valor_pago=valor,status='paga' WHERE id=$1",[f.id])
      await q(`CREATE FUNCTION public.synthetic_http_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_HTTP_FAILURE'; END $$; CREATE TRIGGER synthetic_http_failure BEFORE INSERT ON public.collection_timeline_events FOR EACH ROW WHEN (NEW.tipo='PAGO' AND NEW.contas_financeiras_id='${f.id}'::uuid) EXECUTE FUNCTION public.synthetic_http_failure()`)
      try {
        await assert.rejects(runPaymentReconciliationSweep,e=>e.code==='PAYMENT_RECONCILIATION_PARTIAL_FAILURE')
        assert.equal((await request('GET','/api/financeiro/'+f.id+'/promessa')).body.promessa.status,'ativa')
        assert.equal((await request('GET','/api/financeiro/'+f.id+'/timeline')).body.total,1)
        assert.equal((await q('SELECT status FROM public.collection_dispatches WHERE contas_financeiras_id=$1',[f.id])).rows[0].status,'queued')
      } finally {await q('DROP TRIGGER synthetic_http_failure ON public.collection_timeline_events; DROP FUNCTION public.synthetic_http_failure()')}
      await runPaymentReconciliationSweep()
      assert.equal((await request('GET','/api/financeiro/'+f.id+'/promessa')).body.promessa,null)
      assert.equal((await request('GET','/api/financeiro/'+f.id+'/timeline')).body.total,3)
    })
    await check('HTTP paid-title promise blocked and missing-title read returns 404',async()=>{
      const paid=await fixture({promise:false})
      const r=await request('POST','/api/financeiro/'+paid.id+'/promessa',{data_prometida:promised})
      assert.equal(r.status,409);assert.equal(r.body.motivo,'quitado')
      assert.equal((await request('GET','/api/financeiro/'+randomUUID()+'/timeline')).status,404)
    })
  } finally {
    await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()))
    setHttpPort(0)
    delete process.env.JWT_SECRET
  }
  return {host:'127.0.0.1',port,closed:true,auth:'actual middleware with ephemeral synthetic JWTs'}
}
