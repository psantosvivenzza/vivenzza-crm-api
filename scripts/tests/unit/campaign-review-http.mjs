import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { startCluster, guardNetwork, pg, repo, workspace } from '../../lib/campaign-review-cluster.mjs'
import { createCampaignReviewSimulation, initializeSyntheticTargets } from '../../lib/campaign-review-simulation.mjs'
const { default: express } = await import('express')
const { default: jwt } = await import('jsonwebtoken')
const { createCampaignReviewRouter } = await import('../../../src/routes/campaign-reviews.js')
const run = process.argv[2]
if (!run) throw Error('Unique run argument required')
process.env.JWT_SECRET = randomUUID() + randomUUID()
process.env.API_SECRET_KEY = 'synthetic-static-key'
let port = 0, cluster, pool, server
const network = guardNetwork(15581, () => port)
const report = { run, at: new Date().toISOString(), tests: [], network, stopped: false, published: false, realData: false }
const check = async (name, fn) => { await fn(); report.tests.push({ name, status: 'passed' }); console.log('PASS ' + name) }
const token = (role = 'admin', expiresIn = '5m') => jwt.sign({ id: 'admin-sintetico', role }, process.env.JWT_SECRET, { expiresIn })
async function request(method, url, body, auth = token()) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }))
    }); req.setTimeout(8000, () => req.destroy(Error('SYNTHETIC_HTTP_TIMEOUT'))); req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined)
  })
}
const root = '/api/admin/campaign-reviews'
const create = async (platform = 'meta') => { const r = await request('POST', root + '/simulacoes', { platform }); assert.equal(r.status, 201); return r.body }
const approve = async (p) => { const r = await request('POST', `${root}/${p.id}/aprovar`, { hash: p.hash }); assert.equal(r.status, 200); return r.body }
try {
  cluster = await startCluster(run)
  await initializeSyntheticTargets(cluster.admin)
  pool = new pg.Pool({ ...cluster.config, user: 'service_role', max: 4 })
  const sim = await createCampaignReviewSimulation(pool)
  const app = express(); app.use(root, createCampaignReviewRouter(sim)); app.use('/disabled', createCampaignReviewRouter())
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) }); port = server.address().port
  await check('JWT real: ausente/inválido/expirado 401; vendedor e chave estática 403', async () => {
    for (const auth of [null, 'invalid', token('admin', -1)]) assert.equal((await request('GET', root, null, auth)).status, 401)
    assert.equal((await request('GET', root, null, token('vendedor'))).status, 403)
    assert.equal((await request('GET', root, null, process.env.API_SECRET_KEY)).status, 403)
  })
  await check('Composição padrão falha fechada e respostas não cacheáveis', async () => {
    const r = await request('GET', '/disabled'); assert.equal(r.status, 503); assert.equal(r.body.code, 'REVISAO_NAO_CONFIGURADA'); assert.equal(r.headers['cache-control'], 'no-store')
  })
  await check('Meta e Google: criar, revisar, aprovar sem executar, executar e readback', async () => {
    for (const platform of ['meta', 'google']) {
      const p = await create(platform)
      assert.equal((await request('POST', `${root}/${p.id}/executar`, { hash: p.hash })).status, 409)
      const before = (await cluster.admin.query('SELECT writes FROM campaign_review.synthetic_targets WHERE platform=$1', [platform])).rows[0].writes
      await approve(p)
      assert.equal((await cluster.admin.query('SELECT writes FROM campaign_review.synthetic_targets WHERE platform=$1', [platform])).rows[0].writes, before)
      const r = await request('POST', `${root}/${p.id}/executar`, { hash: p.hash }); assert.equal(r.body.state, 'confirmada'); assert.equal(r.body.history.length, 4)
      assert.equal((await request('POST', `${root}/${p.id}/executar`, { hash: p.hash })).status, 409)
    }
  })
  await check('Rejeição com motivo e hash torna proposta terminal', async () => {
    const p = await create()
    assert.equal((await request('POST', `${root}/${p.id}/rejeitar`, { hash: 'a'.repeat(64), reason: 'Exemplo' })).status, 409)
    const r = await request('POST', `${root}/${p.id}/rejeitar`, { hash: p.hash, reason: 'Não aprovo esta simulação.' })
    assert.equal(r.body.state, 'rejeitada'); assert.equal(r.body.rejection.reason, 'Não aprovo esta simulação.')
    assert.equal((await request('POST', `${root}/${p.id}/aprovar`, { hash: p.hash })).status, 409)
    assert.equal((await request('POST', `${root}/${p.id}/executar`, { hash: p.hash })).status, 409)
  })
  await check('Banco impede alteração do payload/histórico e DELETE por service_role', async () => {
    const p = await create()
    await assert.rejects(() => pool.query("UPDATE campaign_review.proposals SET record=jsonb_set(record,'{payload,reason}','\"alterado\"') WHERE id=$1", [p.id]), (e) => e.code === '23514')
    await assert.rejects(() => pool.query("UPDATE campaign_review.proposals SET record=jsonb_set(record,'{history,0,actorId}','\"alterado\"') WHERE id=$1", [p.id]), (e) => e.code === '23514')
    await assert.rejects(() => pool.query('DELETE FROM campaign_review.proposals WHERE id=$1', [p.id]), (e) => e.code === '42501')
  })
  await check('Anon/authenticated sem acesso ao schema privado', async () => {
    for (const user of ['anon', 'authenticated']) {
      const c = new pg.Client(cluster.config); await c.connect()
      try {
        await c.query('SET ROLE ' + user)
        assert.equal((await c.query('SELECT current_user AS role')).rows[0].role, user)
        await assert.rejects(() => c.query('SELECT * FROM campaign_review.proposals'), (e) => e.code === '42501')
      } finally { await c.end() }
    }
    assert.equal((await cluster.admin.query("SELECT relrowsecurity FROM pg_class WHERE oid='campaign_review.proposals'::regclass")).rows[0].relrowsecurity, true)
  })
  await check('Duas conexões PostgreSQL: CAS concorrente executa uma única vez', async () => {
    const a = await pool.connect(), b = await pool.connect()
    try { assert.notEqual((await a.query('SELECT pg_backend_pid() AS id')).rows[0].id, (await b.query('SELECT pg_backend_pid() AS id')).rows[0].id) } finally { a.release(); b.release() }
    const p = await create(); await approve(p)
    const before = (await cluster.admin.query("SELECT writes FROM campaign_review.synthetic_targets WHERE platform='meta'")).rows[0].writes
    const rs = await Promise.all([request('POST', `${root}/${p.id}/executar`, { hash: p.hash }), request('POST', `${root}/${p.id}/executar`, { hash: p.hash })])
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409])
    assert.equal((await cluster.admin.query("SELECT writes FROM campaign_review.synthetic_targets WHERE platform='meta'")).rows[0].writes, before + 1)
  })
  await check('Duas propostas para o mesmo alvo não escrevem simultaneamente', async () => {
    const a = await create(), b = await create(); await approve(a); await approve(b)
    const original = sim.adapter.read; let release, entered
    const gate = new Promise((r) => { release = r }), reached = new Promise((r) => { entered = r })
    sim.adapter.read = async (target) => { entered(); await gate; return original(target) }
    const first = request('POST', `${root}/${a.id}/executar`, { hash: a.hash })
    try {
      let timer
      try { await Promise.race([reached, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('SYNTHETIC_BARRIER_TIMEOUT')), 5000) })]) } finally { clearTimeout(timer) }
      const second = await request('POST', `${root}/${b.id}/executar`, { hash: b.hash })
      assert.equal(second.status, 409)
    } finally { release(); sim.adapter.read = original }
    assert.equal((await first).body.state, 'confirmada')
  })
  await check('Timeout depois da escrita persiste inconclusiva e bloqueia replay', async () => {
    const p = await create(); await approve(p); const write = sim.adapter.write
    sim.adapter.write = async (target) => { await write(target); throw Error('SYNTHETIC_ACK_LOST') }
    try { assert.equal((await request('POST', `${root}/${p.id}/executar`, { hash: p.hash })).body.state, 'inconclusiva') } finally { sim.adapter.write = write }
    assert.equal((await request('POST', `${root}/${p.id}/executar`, { hash: p.hash })).status, 409)
    const another = await create(); await approve(another)
    assert.equal((await request('POST', `${root}/${another.id}/executar`, { hash: another.hash })).status, 409)
  })
  await check('Erro no commit final conserva em execução e bloqueia repetição', async () => {
    const p = await create('google'); await approve(p)
    await cluster.admin.query(`CREATE FUNCTION campaign_review.synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_FINAL_FAILURE'; END $$; CREATE TRIGGER synthetic_fail BEFORE UPDATE ON campaign_review.proposals FOR EACH ROW WHEN (NEW.state='confirmada') EXECUTE FUNCTION campaign_review.synthetic_fail()`)
    try { assert.equal((await request('POST', `${root}/${p.id}/executar`, { hash: p.hash })).status, 503) }
    finally { await cluster.admin.query('DROP TRIGGER synthetic_fail ON campaign_review.proposals; DROP FUNCTION campaign_review.synthetic_fail()') }
    assert.equal((await request('GET', `${root}/${p.id}`)).body.state, 'em execução')
    assert.equal((await request('POST', `${root}/${p.id}/executar`, { hash: p.hash })).status, 409)
  })
  await check('Pedidos extras/injeção de ator ou conteúdo são recusados', async () => {
    const p = await create()
    assert.equal((await request('POST', `${root}/${p.id}/aprovar`, { hash: p.hash, role: 'admin', payload: {} })).status, 400)
    assert.equal((await request('POST', root + '/simulacoes', { platform: 'google', accountId: 'real' })).status, 400)
    assert.equal((await request('GET', root + '/invalid')).status, 400)
    assert.equal((await request('POST', `${root}/${p.id}/aprovar`, { hash: [p.hash] })).status, 400)
    for (const reason of [{}, '', ' ', 'a'.repeat(1001), 'controle\u0001']) assert.equal((await request('POST', `${root}/${p.id}/rejeitar`, { hash: p.hash, reason })).status, 400)
    const invalid = structuredClone(p); invalid.id = randomUUID(); invalid.payload.accountId = null
    await assert.rejects(() => pool.query('INSERT INTO campaign_review.proposals(id,revision,state,record) VALUES($1,1,$2,$3::jsonb)', [invalid.id, 'proposta', JSON.stringify(invalid)]), (e) => e.code === '23514')
  })
  await check('Restart PostgreSQL e novo workflow conservam propostas/histórico', async () => {
    const p = await create('google'); await approve(p)
    await pool.end(); await cluster.admin.end(); cluster.stop(); cluster.start()
    cluster.admin = new pg.Client(cluster.config); await cluster.admin.connect()
    pool = new pg.Pool({ ...cluster.config, user: 'service_role', max: 4 })
    const restored = await createCampaignReviewSimulation(pool)
    const r = await restored.workflow.get(p.id, { id: 'admin-sintetico', role: 'admin' })
    assert.equal(r.state, 'aprovada'); assert.equal(r.history.length, 2); assert.equal(r.approval.hash, p.hash)
    // Rebind the same injected adapter/store ports used by the HTTP workflow.
    Object.assign(sim.store, restored.store); Object.assign(sim.adapter, restored.adapter)
    assert.equal((await request('GET', `${root}/${p.id}`)).body.state, 'aprovada')
  })
  report.migrationSha256 = createHash('sha256').update(fs.readFileSync(path.join(repo, 'scripts/sql/campaign_review_proposals_candidate.sql'))).digest('hex')
} catch (e) { report.failure = { code: e.code ?? null, message: e.message }; process.exitCode = 1; console.error(e.stack) }
finally {
  if (server) await new Promise((r) => server.close(r))
  if (pool) await pool.end().catch(() => {})
  if (cluster) { await cluster.admin.end().catch(() => {}); try { cluster.stop(); report.stopped = true } catch (e) { report.stopError = e.message; process.exitCode = 1 } }
  fs.writeFileSync(path.join(workspace, 'output', `VIVENZZA_CAMPANHAS_HTTP_${run}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.tests.length, failure: report.failure, stopped: report.stopped, network }))
}
