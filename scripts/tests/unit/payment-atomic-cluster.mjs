// Dedicated synthetic cluster only. No .env, application startup or real integration.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registerHooks, createRequire } from 'node:module'
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const workspace = path.dirname(repo)
const { default: pg } = await import(pathToFileURL(path.join(workspace, '.pgtest-cache/node_modules/pg/lib/index.js')).href)
const migrationManifest=JSON.parse(fs.readFileSync(path.join(repo,'docs/proposals/payment-local-migration-manifest.json'),'utf8'))
assert.match(migrationManifest.file,/^supabase\/migrations\/\d{14}_collection_payment_atomic\.sql$/)
const sqlPath = path.join(repo, migrationManifest.file)
const sql = fs.readFileSync(sqlPath, 'utf8')
assert.equal(createHash('sha256').update(sql).digest('hex'),migrationManifest.sha256)
const run = process.env.VIVENZZA_ATOMIC_RUN
if (!/^[a-z0-9-]+$/.test(run || '')) throw Error('Unique VIVENZZA_ATOMIC_RUN required')
const port = 15579
const database = 'vivenzza_atomic_rpc_synthetic'
const dir = path.join(repo, '.localdev', 'atomic-' + run)
if (fs.existsSync(dir)) throw Error('Run directory already exists; never reuse cluster')
fs.mkdirSync(dir, { recursive: true })
const bin = path.resolve(workspace, 'tools/vivenzza-postgresql-17.11-5/pgsql/bin')
function runtime(exe, args, ignore = false) {
  const result = spawnSync(path.join(bin, exe + '.exe'), args, { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ignore ? 'ignore' : 'pipe' })
  if (result.status !== 0) throw Error(exe + ': ' + (result.error?.code || result.stderr || result.status))
  return result.stdout
}
await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)) })
const connect = net.Socket.prototype.connect
let httpPort=0
const network={tcpAllowed:0,tcpBlocked:0,fetchBlocked:0}
const allowedPort=p=>Number(p)===port||(httpPort!==0&&Number(p)===httpPort)
net.Socket.prototype.connect = function (...args) {
  // http.Agent may pass Node's already-normalized [options, callback] array.
  const normalized=Array.isArray(args[0])?args[0]:args
  const a=normalized[0],options=a!==null&&typeof a==='object'
  const host=options?(a.host??a.hostname):normalized[1]
  const targetPort=options?a.port:a
  if(host!=='127.0.0.1'||!['number','string'].includes(typeof targetPort)||!allowedPort(targetPort)){
    network.tcpBlocked++
    throw Error('Network forbidden outside exclusive loopback PostgreSQL/HTTP harness')
  }
  network.tcpAllowed++
  return connect.apply(this, args)
}
globalThis.fetch = async () => { network.fetchBlocked++;throw Error('External fetch forbidden') }
const report = { at: new Date().toISOString(), run, port, database, postgres: null, migrationFile:migrationManifest.file, sqlSha256: createHash('sha256').update(sql).digest('hex'), network, tests: [], stopped: false, published: false, realData: false }
const clients = new Set()
async function client(role) {
  const c = new pg.Client({ host: '127.0.0.1', port, database, user: 'postgres', connectionTimeoutMillis: 4000, statement_timeout: 10000 })
  await c.connect(); clients.add(c)
  if (role) await c.query('SET ROLE ' + role)
  return c
}
let admin, localDb, started = false
async function check(name, fn) {
  try { const evidence = await fn(); report.tests.push({ name, status: 'passed', evidence }); console.log('PASS ' + name) }
  catch (e) { report.tests.push({ name, status: 'failed', code: e.code || null, message: e.message }); console.log('FAIL ' + name + ': ' + e.message) }
}
const q = (s, a) => admin.query(s, a)
const rpc = async (c, id) => (await c.query('SELECT public.collection_cancel_paid_atomic($1) AS r', [id])).rows[0].r
async function fixture({ valor = '10', pago = '10', status = 'paga', review = false, promise = true, dispatch = true } = {}) {
  const id = randomUUID(), pid = randomUUID()
  await q('INSERT INTO public.contas_financeiras(id,valor,valor_pago,status,em_revisao_financeira) VALUES($1,$2,$3,$4,$5)', [id, valor, pago, status, review])
  if (dispatch) await q("INSERT INTO public.collection_dispatches(contas_financeiras_id,idempotency_key,origem,mensagem,cliente_nome,cliente_telefone) VALUES($1,$2,'cron','SYNTHETIC','SYNTHETIC','00000000000')", [id, randomUUID()])
  if (promise) await q("INSERT INTO public.collection_promises(id,contas_financeiras_id,cliente_nome,valor,promised_date,origem) VALUES($1,$2,'SYNTHETIC',10,'2099-01-01','HUMAN')", [pid, id])
  return { id, pid }
}
async function snapshot(id) {
  return (await q(`SELECT
    (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.collection_dispatches d WHERE contas_financeiras_id=$1) AS dispatches,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM public.collection_promises p WHERE contas_financeiras_id=$1) AS promises,
    (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.collection_timeline_events e WHERE contas_financeiras_id=$1) AS events`, [id])).rows[0]
}
async function concurrent(c1, c2, fn, id) {
  // Hold the actual business advisory key until both independent backends wait.
  // q uses the dedicated admin pg.Client, not a pool.
  const owner = (await q("SELECT pg_backend_pid() AS pid,pg_advisory_lock(hashtextextended('collection-payment:' || $1::text,0))", [id])).rows[0].pid
  const pids = [c1.processID, c2.processID]
  const a = fn(c1)
  a.catch(()=>{}) // keep rejection handled while the barrier inspects backends
  let b
  try {
    // Establish FIFO contention deliberately, so both business winners can be tested.
    let firstWaiting=false
    for(let i=0;i<50&&!firstWaiting;i++){
      firstWaiting=Number((await q("SELECT count(*) AS n FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory'",[c1.processID])).rows[0].n)===1
      if(!firstWaiting)await new Promise(r=>setTimeout(r,20))
    }
    assert.equal(firstWaiting,true,'First backend must enter the lock queue')
    b=fn(c2);b.catch(()=>{})
    let waiting = 0
    for (let i = 0; i < 50 && waiting < 2; i++) {
      waiting = Number((await q("SELECT count(*) AS n FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event='advisory'", [pids])).rows[0].n)
      if (waiting < 2) await new Promise(r => setTimeout(r, 20))
    }
    assert.equal(waiting, 2, 'Both real backends must reach the contention barrier')
  } finally {
    const unlocked = (await q("SELECT pg_backend_pid() AS pid,pg_advisory_unlock(hashtextextended('collection-payment:' || $1::text,0)) AS released", [id])).rows[0]
    assert.equal(unlocked.pid, owner, 'Lock and unlock must use the same dedicated backend')
    assert.equal(unlocked.released, true, 'Barrier lock must be released')
  }
  return Promise.all([a, b])
}
try {
  report.postgres = runtime('pg_ctl', ['--version']).trim()
  runtime('initdb', ['-D', dir, '-U', 'postgres', '-E', 'UTF8', '--locale=C', '--auth=trust', '--no-instructions'])
  // No socket outside the run directory, no external address, no autostart.
  runtime('pg_ctl', ['-D', dir, '-l', path.join(dir, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1`, '-w', 'start'], true)
  started = true
  const bootstrap = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', connectionTimeoutMillis: 4000 })
  await bootstrap.connect(); await bootstrap.query('CREATE DATABASE ' + database); await bootstrap.end()
  admin = await client()
  const identity = (await q("SELECT current_database() AS db,host(inet_server_addr()) AS host,current_setting('data_directory') AS dir,current_setting('listen_addresses') AS listen,current_setting('port') AS port")).rows[0]
  assert.equal(identity.db, database); assert.equal(identity.host, '127.0.0.1'); assert.equal(path.resolve(identity.dir), dir); assert.equal(identity.listen, '127.0.0.1')
  // Verify the real path above, but do not publish the workstation user/path.
  report.identity = { ...identity, dir: '<exclusive-synthetic-cluster>' }
  const metadata = JSON.parse(fs.readFileSync(path.join(repo, 'docs/proposals/payment-atomic-schema-metadata.json'), 'utf8'))
  await q('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role LOGIN BYPASSRLS; CREATE TABLE public.usuarios(id uuid PRIMARY KEY)')
  const types = new Set(['uuid','integer','text','numeric','timestamp with time zone','date','jsonb','character varying','boolean'])
  const tables = ['contas_financeiras','collection_dispatches','collection_promises','collection_timeline_events']
  for (const table of tables) {
    const cols = metadata.columns.filter(c => c.table_name === table).map(c => {
      assert.match(c.column_name, /^[a-z_]+$/); assert(types.has(c.data_type))
      const defaults = [null,'gen_random_uuid()','now()',"'whatsapp'::text","'queued'::text","'collection'::text","'ativa'::text","'aberta'::character varying",'0','false']
      assert(defaults.includes(c.column_default), 'Default must be explicitly reviewed')
      return c.column_name + ' ' + c.data_type + (c.is_nullable === 'NO' ? ' NOT NULL' : '') + (c.column_default ? ' DEFAULT ' + c.column_default : '')
    })
    await q(`CREATE TABLE public.${table}(${cols.join(',')})`)
  }
  await q('ALTER TABLE public.contas_financeiras ADD PRIMARY KEY(id)')
  for (const c of metadata.constraints) {
    assert(tables.includes(c.table_name)); assert.match(c.conname, /^[a-z_]+$/)
    assert(!/[;]|--|\/\*/.test(c.definition))
    await q(`ALTER TABLE public.${c.table_name} ADD CONSTRAINT ${c.conname} ${c.definition}`)
  }
  await q("CREATE UNIQUE INDEX synthetic_active_promise ON public.collection_promises(contas_financeiras_id) WHERE status='ativa'; CREATE UNIQUE INDEX synthetic_dispatch_key ON public.collection_dispatches(idempotency_key)")
  for (const t of tables) await q(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`)
  await q('GRANT USAGE ON SCHEMA public TO service_role,anon,authenticated; GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA public TO service_role')
  await q(sql)
  report.appliedToSynthetic = true
  // Only synthetic baseline fields needed by the existing HTTP promise route.
  await q("ALTER TABLE public.contas_financeiras ADD COLUMN pessoa_nome text DEFAULT 'SYNTHETIC', ADD COLUMN telefone_cobranca text DEFAULT '00000000000'")
  const service = await client('service_role'), c2 = await client('service_role')
  await check('RPC compile / service_role / DTO / events / retry after ignored committed result', async () => {
    const { id } = await fixture()
    const r = await rpc(service, id)
    assert.deepEqual(r, { dispatches: 1, promessaCumprida: true, ligacoes: 0, motivo: 'quitado' })
    const events = (await q('SELECT tipo,origem,dados,cliente_telefone,canal,criado_por FROM public.collection_timeline_events WHERE contas_financeiras_id=$1', [id])).rows
    assert.equal(events.length, 2); assert(events.every(e => e.origem === 'PAYMENT_RECONCILIATION' && e.canal === null && e.criado_por === null))
    assert.deepEqual(events.find(e => e.tipo === 'PAGO').dados, r)
    assert.deepEqual(await rpc(service, id), { ...r, dispatches: 0, promessaCumprida: false })
    assert.equal((await snapshot(id)).events.length, 2)
  })
  for (const tipo of ['PROMESSA_CUMPRIDA','PAGO']) await check('Rollback complete on ' + tipo + ' insert failure', async () => {
    const { id } = await fixture(), before = await snapshot(id)
    await q(`CREATE FUNCTION public.synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_WRITE_FAILURE'; END $$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON public.collection_timeline_events FOR EACH ROW WHEN (NEW.tipo='${tipo}') EXECUTE FUNCTION public.synthetic_fail()`)
    try { await assert.rejects(() => rpc(service, id), e => e.code === 'P0001' && e.message === 'SYNTHETIC_WRITE_FAILURE'); assert.deepEqual(await snapshot(id), before) }
    finally { await q('DROP TRIGGER synthetic_fail ON public.collection_timeline_events; DROP FUNCTION public.synthetic_fail()') }
    assert.equal((await rpc(service, id)).promessaCumprida, true)
  })
  await check('Two real connections / same title / exact-once transitions and events', async () => {
    const { id } = await fixture()
    const results = await concurrent(service,c2,c => rpc(c,id),id)
    assert.equal(results.reduce((a,r) => a+r.dispatches,0),1); assert.equal(results.filter(r => r.promessaCumprida).length,1)
    const s = await snapshot(id); assert.equal(s.events.length,2); assert.equal(s.promises[0].status,'cumprida')
    return { backends: 2, dispatchTransitions: 1, promiseTransitions: 1, events: 2 }
  })
  await check('Direct promise RPC concurrent / null retry / allowed origin / invalid origin', async () => {
    const { id,pid } = await fixture({dispatch:false})
    const fn = async c => (await c.query("SELECT public.collection_fulfill_promise_atomic($1,'HUMAN') AS r",[pid])).rows[0].r
    const rs = await concurrent(service,c2,fn,id); assert.equal(rs.filter(Boolean).length,1)
    assert.equal((await snapshot(id)).events.length,1); assert.equal(await fn(service),null)
    const second = await fixture({dispatch:false}); const before=await snapshot(second.id)
    await assert.rejects(()=>service.query("SELECT public.collection_fulfill_promise_atomic($1,'INVALID')",[second.pid]),e=>e.code==='22023')
    assert.deepEqual(await snapshot(second.id),before)
  })
  for(const dispatch of [true,false])for(const first of ['cancel','human'])await check('Mixed cancel versus direct HUMAN fulfillment / dispatch='+dispatch+' / first='+first,async()=>{
    const {id,pid}=await fixture({dispatch})
    const fn=async c=>c===service?rpc(c,id):(await c.query("SELECT public.collection_fulfill_promise_atomic($1,'HUMAN') AS r",[pid])).rows[0].r
    const results=await concurrent(first==='cancel'?service:c2,first==='cancel'?c2:service,fn,id)
    const [cancel,direct]=first==='cancel'?results:[results[1],results[0]]
    const es=(await snapshot(id)).events
    const fulfilled=es.filter(e=>e.tipo==='PROMESSA_CUMPRIDA')
    assert.equal(fulfilled.length,1)
    assert.equal(fulfilled[0].origem,first==='human'?'HUMAN':'PAYMENT_RECONCILIATION')
    if(direct){assert.equal(fulfilled[0].origem,'HUMAN');assert.equal(cancel.promessaCumprida,false)}
    else{assert.equal(fulfilled[0].origem,'PAYMENT_RECONCILIATION');assert.equal(cancel.promessaCumprida,true)}
    assert.equal(es.filter(e=>e.tipo==='PAGO').length,dispatch||cancel.promessaCumprida?1:0)
    assert.equal(cancel.dispatches,dispatch?1:0)
    return {backends:2,promiseEvents:1,pagoEvents:es.filter(e=>e.tipo==='PAGO').length,winner:fulfilled[0].origem}
  })
  for (const [name,args,reason,cancel] of [
    ['open',{pago:'0',status:'aberta'},null,false], ['cancelled',{status:'cancelada'},'cancelado',true], ['review',{review:true},'em_revisao_financeira',true], ['zero balance',{valor:'0',pago:'0'},'quitado',true], ['partial',{pago:'9.99'},null,false], ['overpaid',{pago:'11'},'quitado',true],
  ]) await check('Reason parity: '+name,async()=>{
    const {id}=await fixture(args); const r=await rpc(service,id);assert.equal(r.motivo,reason);assert.equal(r.dispatches,cancel?1:0)
    const s=await snapshot(id); assert.equal(s.events?.length||0,reason==='quitado'?2:0);assert.equal(s.promises[0].status,reason==='quitado'?'cumprida':'ativa')
  })
  await check('Missing title / no invented payment event',async()=>{assert.deepEqual(await rpc(service,randomUUID()),{dispatches:0,promessaCumprida:false,ligacoes:0,motivo:'titulo_inexistente'})})
  await check('Existing historical PAGO preserved / no backfill or duplication',async()=>{
    const {id}=await fixture();await q("INSERT INTO public.collection_timeline_events(contas_financeiras_id,tipo,origem,descricao) VALUES($1,'PAGO','HUMAN','SYNTHETIC EXISTING')",[id]);await rpc(service,id)
    const es=(await snapshot(id)).events;assert.equal(es.filter(e=>e.tipo==='PAGO').length,1);assert.equal(es.find(e=>e.tipo==='PAGO').descricao,'SYNTHETIC EXISTING')
  })
  await check('Optional call queue present / cancellation and counts',async()=>{
    await q('CREATE TABLE public.collection_calls(id uuid PRIMARY KEY,contas_financeiras_id uuid,status text); GRANT SELECT,UPDATE ON public.collection_calls TO service_role')
    const {id}=await fixture();await q("INSERT INTO public.collection_calls VALUES($1,$2,'agendada')",[randomUUID(),id]);assert.equal((await rpc(service,id)).ligacoes,1)
  })
  await check('Optional call table permission failure rolls back',async()=>{
    const {id}=await fixture();const before=await snapshot(id);await q('REVOKE UPDATE ON public.collection_calls FROM service_role')
    try{await assert.rejects(()=>rpc(service,id),e=>e.code==='42501');assert.deepEqual(await snapshot(id),before)}finally{await q('GRANT UPDATE ON public.collection_calls TO service_role')}
  })
  await check('Optional call column mismatch rolls back',async()=>{
    const {id}=await fixture();const before=await snapshot(id);await q('ALTER TABLE public.collection_calls RENAME COLUMN status TO synthetic_wrong_status')
    try{await assert.rejects(()=>rpc(service,id),e=>e.code==='42703');assert.deepEqual(await snapshot(id),before)}finally{await q('ALTER TABLE public.collection_calls RENAME COLUMN synthetic_wrong_status TO status')}
  })
  for (const role of ['anon','authenticated']) await check('RPC ACL denies '+role,async()=>{
    const c=await client(role);await assert.rejects(()=>rpc(c,randomUUID()),e=>e.code==='42501');await assert.rejects(()=>c.query('SELECT public.collection_fulfill_promise_atomic($1)',[randomUUID()]),e=>e.code==='42501')
  })
  await check('Isolation rejects REPEATABLE READ without transitions',async()=>{
    const {id}=await fixture();const before=await snapshot(id);await service.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
    try{await assert.rejects(()=>rpc(service,id),e=>e.code==='25001')}finally{await service.query('ROLLBACK')};assert.deepEqual(await snapshot(id),before)
  })
  await check('Row lock timeout preserves all pending work and retry recovers',async()=>{
    const {id}=await fixture(),before=await snapshot(id)
    await c2.query('BEGIN')
    try {
      await c2.query('SELECT id FROM public.contas_financeiras WHERE id=$1 FOR UPDATE',[id])
      await assert.rejects(()=>rpc(service,id),e=>e.code==='55P03')
      assert.deepEqual(await snapshot(id),before)
    } finally {await c2.query('ROLLBACK')}
    const recovered=await rpc(service,id)
    assert.equal(recovered.dispatches,1)
    assert.equal(recovered.promessaCumprida,true)
    assert.equal((await snapshot(id)).events.length,2)
    assert.equal((await rpc(service,id)).dispatches,0)
    assert.equal((await snapshot(id)).events.length,2)
    return {timeoutCode:'55P03',rollbackComplete:true,retryEvents:2}
  })
  await check('Independent title proceeds while other title key is locked',async()=>{
    const a=await fixture(),b=await fixture();await q("SELECT pg_advisory_lock(hashtextextended('collection-payment:' || $1::text,0))",[a.id])
    try{assert.equal((await rpc(service,b.id)).dispatches,1)}finally{await q("SELECT pg_advisory_unlock(hashtextextended('collection-payment:' || $1::text,0))",[a.id])}
  })
  await check('Future event ordering strictly promise before PAGO',async()=>{
    for(let i=0;i<20;i++){
      const {id}=await fixture();await rpc(service,id)
      const r=(await q("SELECT (SELECT criado_em FROM public.collection_timeline_events WHERE contas_financeiras_id=$1 AND tipo='PROMESSA_CUMPRIDA') < (SELECT criado_em FROM public.collection_timeline_events WHERE contas_financeiras_id=$1 AND tipo='PAGO') AS ordered",[id])).rows[0]
      assert.equal(r.ordered,true,'Promise must precede PAGO even in one transaction')
    }
    return {iterations:20,strictlyOrdered:true}
  })
  // Actual application exports -> actual pgCompatClient -> PostgreSQL RPC.
  // Replace only credential-bearing bootstrap; never import .env or start app/jobs.
  const dependencyRequire=createRequire(path.join(workspace,'vivenzza-crm-api/package.json'))
  const dependencyUrls=Object.fromEntries(['express','jsonwebtoken'].map(s=>[s,pathToFileURL(dependencyRequire.resolve(s)).href]))
  registerHooks({resolve(s,c,next){
    if(s==='pg')return next(pathToFileURL(path.join(workspace,'.pgtest-cache/node_modules/pg/lib/index.js')).href,c)
    if(dependencyUrls[s])return next(dependencyUrls[s],c)
    if(s.endsWith('/supabase-admin.server.js'))return {shortCircuit:true,url:"data:text/javascript,export const supabase=globalThis[Symbol.for('vivenzza.atomic.actual-db')]"}
    return next(s,c)
  }})
  const {createLocalPgClient}=await import('../../../src/lib/localdev/pgCompatClient.js')
  localDb=createLocalPgClient(`postgres://service_role@127.0.0.1:${port}/${database}`)
  globalThis[Symbol.for('vivenzza.atomic.actual-db')]=localDb
  const actual=await import('../../../src/lib/collection/paymentGuard.js')
  const promises=await import('../../../src/lib/collection/promises.js')
  await check('Actual JS adapters + actual SQL adapter + PostgreSQL RPC',async()=>{
    const paid=await fixture()
    assert.equal((await actual.cancelarAutomacaoPorPagamento(paid.id)).promessaCumprida,true)
    assert.equal((await actual.cancelarAutomacaoPorPagamento(paid.id)).dispatches,0)
    const direct=await fixture({dispatch:false})
    assert.equal((await promises.marcarPromessaCumprida(direct.pid)).status,'cumprida')
    assert.equal(await promises.marcarPromessaCumprida(direct.pid),null)
    assert.equal((await snapshot(direct.id)).events[0].origem,'SYSTEM')
  })
  await check('Actual sweep aggregates one rollback, continues and recovers on next sweep',async()=>{
    const failed=await fixture(),good=await fixture(),open=await fixture({pago:'0',status:'aberta'})
    const before=await snapshot(failed.id)
    await q(`CREATE FUNCTION public.synthetic_fail_sweep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_SWEEP_FAILURE'; END $$; CREATE TRIGGER synthetic_fail_sweep BEFORE INSERT ON public.collection_timeline_events FOR EACH ROW WHEN (NEW.tipo='PAGO' AND NEW.contas_financeiras_id='${failed.id}'::uuid) EXECUTE FUNCTION public.synthetic_fail_sweep()`)
    try {
      await assert.rejects(actual.varrerTitulosPendentesEcancelarQuitados,e=>e.code==='PAYMENT_RECONCILIATION_PARTIAL_FAILURE'&&e.resultado.falhas===1)
      assert.deepEqual(await snapshot(failed.id),before)
      assert.equal((await snapshot(good.id)).promises[0].status,'cumprida')
      assert.equal((await snapshot(open.id)).dispatches[0].status,'queued')
    }finally{await q('DROP TRIGGER synthetic_fail_sweep ON public.collection_timeline_events; DROP FUNCTION public.synthetic_fail_sweep()')}
    await actual.varrerTitulosPendentesEcancelarQuitados()
    assert.equal((await snapshot(failed.id)).events.length,2)
    assert.equal((await snapshot(open.id)).promises[0].status,'ativa')
  })
  const {runHttpHomologation}=await import('./payment-local-http-homolog.mjs')
  report.http=await runHttpHomologation({workspace,fixture,q,check,setHttpPort:p=>{httpPort=p}})
  assert.equal(network.tcpBlocked,0,'No out-of-scope TCP attempts should occur')
  assert.equal(network.fetchBlocked,0,'No external fetch attempts should occur')
} catch(e) { report.fatal = { code:e.code||null,message:e.message }; console.error(e.message) }
finally {
  if(localDb)try{await localDb._pool.end()}catch{}
  for (const c of clients) try { await c.end() } catch {}
  if(started)try{runtime('pg_ctl',['-D',dir,'-m','fast','-w','stop'],true);report.stopped=true}catch(e){report.stopError=e.message}
  report.passed=report.tests.filter(t=>t.status==='passed').length;report.failed=report.tests.filter(t=>t.status==='failed').length
  fs.writeFileSync(path.join(repo,'docs/proposals','payment-atomic-results-'+run+'.json'),JSON.stringify(report,null,2))
  console.log(JSON.stringify({passed:report.passed,failed:report.failed,fatal:report.fatal,stopped:report.stopped}))
  process.exitCode=report.fatal||report.failed||!report.stopped?1:0
}
