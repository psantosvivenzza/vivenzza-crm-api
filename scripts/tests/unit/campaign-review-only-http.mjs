// Modo somente revisão: router real + composição real + PostgreSQL exclusivo (porta 15582).
// Uso: node scripts/tests/unit/campaign-review-only-http.mjs IDENTIFICADOR-NOVO
// Fixtures: somente política sintética em scripts/fixtures; nenhum adapter, provedor, WhatsApp ou planilha.
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { startCluster, guardNetwork, pg, repo, workspace } from '../../lib/campaign-review-cluster.mjs'
const { default: express } = await import('express')
const { default: jwt } = await import('jsonwebtoken')
const { createCampaignReviewRouter } = await import('../../../src/routes/campaign-reviews.js')
const { createCampaignReviewComposition, MANUAL_SOURCE } = await import('../../../src/lib/campaignReviewComposition.js')
const run = process.argv[2]
if (!run) throw Error('Unique run argument required')
const PG_PORT = 15582
process.env.JWT_SECRET = randomUUID() + randomUUID()
process.env.API_SECRET_KEY = 'synthetic-static-key'
const policy = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/fixtures/campaign-review-homologation-policy.json'), 'utf8'))
let port = 0, cluster, pool, server, app
const network = guardNetwork(PG_PORT, () => port)
const report = { run, at: new Date().toISOString(), mode: 'review', tests: [], network, stopped: false, published: false, realData: false, adapter: false }
const check = async (name, fn) => { await fn(); report.tests.push({ name, status: 'passed' }); console.log('PASS ' + name) }
const token = (role = 'admin', id = 'revisor-sintetico') => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '5m' })
function request(method, url, body, auth = token()) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' } }, (res) => {
      let data = ''; res.on('data', (c) => { data += c }); res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }))
    }); req.setTimeout(8000, () => req.destroy(Error('SYNTHETIC_HTTP_TIMEOUT'))); req.on('error', reject); req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body))
  })
}
const root = '/api/admin/campaign-reviews'
const manual = (extra = {}) => ({ platform: 'meta', accountId: 'conta-homologacao-meta', campaignId: 'campanha-homologacao-meta', action: 'daily_budget',
  before: { status: 'ACTIVE', dailyBudgetMinor: 2000, currency: 'BRL' }, after: { status: 'ACTIVE', dailyBudgetMinor: 2500, currency: 'BRL' },
  objective: 'Conversas iniciadas', reason: 'Revisor propõe aumento limitado.', observationSummary: 'Valor visto pelo revisor; não consultado no provedor.', ...extra })
const row = async (id) => (await cluster.admin.query('SELECT revision,state,record FROM campaign_review.proposals WHERE id=$1', [id])).rows[0]
const mount = () => {
  app = express()
  app.use(root, createCampaignReviewRouter(createCampaignReviewComposition({ db: pool, policy })))
  app.use('/disabled', createCampaignReviewRouter())
  return new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
}
try {
  cluster = await startCluster(run, PG_PORT)
  pool = new pg.Pool({ ...cluster.config, user: 'service_role', max: 4 })
  server = await mount(); port = server.address().port
  let approvedId
  await check('GET informa modo revisão, sem execução, com intake e horário da consulta', async () => {
    const r = await request('GET', root)
    assert.equal(r.status, 200); assert.equal(r.body.mode, 'review'); assert.deepEqual(r.body.capabilities, { execute: false, intake: true })
    assert.ok(Number.isFinite(Date.parse(r.body.consultadoEm))); assert.deepEqual(r.body.proposals, [])
  })
  await check('Composição padrão (sem workflow) continua 503 fail-closed', async () => {
    const r = await request('GET', '/disabled'); assert.equal(r.status, 503); assert.equal(r.body.code, 'REVISAO_NAO_CONFIGURADA')
  })
  await check('Registro manual: origem/fonte/observação/validade definidas pelo servidor e persistidas', async () => {
    const r = await request('POST', root + '/propostas', manual())
    assert.equal(r.status, 201); assert.deepEqual(r.body.payload.origin, { kind: 'manual', verified: false })
    assert.equal(r.body.payload.evidence.source, MANUAL_SOURCE); assert.equal(r.body.history[0].actorId, 'revisor-sintetico')
    const db = await row(r.body.id); assert.equal(db.state, 'proposta'); assert.equal(db.record.hash, r.body.hash)
  })
  await check('Navegador não declara origem, fonte, horário, validade ou ator; papel/sessão exigidos', async () => {
    for (const extra of [{ origin: { kind: 'manual', verified: true } }, { source: 'Meta Ads API' }, { observedAt: new Date().toISOString() }, { expiresAt: new Date(Date.now() + 1e9).toISOString() }, { actorId: 'outro' }, { schemaVersion: 2 }])
      assert.equal((await request('POST', root + '/propostas', manual(extra))).status, 400)
    assert.equal((await request('POST', root + '/propostas', manual({ reason: 'controle\u0001' }))).status, 400)
    assert.equal((await request('POST', root + '/propostas', manual({ campaignId: 'fora-da-politica' }))).body.code, 'ALVO_NAO_PERMITIDO')
    assert.equal((await request('POST', root + '/propostas', manual(), token('vendedor'))).status, 403)
    assert.equal((await request('POST', root + '/propostas', manual(), process.env.API_SECRET_KEY)).status, 403)
    assert.equal((await request('POST', root + '/simulacoes', { platform: 'meta' })).status, 403)
  })
  await check('Aprovar registra decisão humana identificada; nada é executado', async () => {
    const p = (await request('POST', root + '/propostas', manual())).body
    assert.equal((await request('POST', `${root}/${p.id}/aprovar`, { hash: 'c'.repeat(64) })).body.code, 'CONTEUDO_ALTERADO')
    const a = await request('POST', `${root}/${p.id}/aprovar`, { hash: p.hash })
    assert.equal(a.status, 200); assert.equal(a.body.state, 'aprovada'); assert.equal(a.body.approval.actorId, 'revisor-sintetico'); assert.equal(a.body.approval.hash, p.hash)
    const db = await row(p.id); assert.equal(db.revision, 2); assert.equal(db.state, 'aprovada')
    approvedId = p.id
  })
  await check('POST direto de execução recusado antes do workflow: estado, revisão e histórico intactos', async () => {
    const before = await row(approvedId)
    for (const body of [{ hash: before.record.hash }, {}, { hash: 'x' }, undefined]) {
      const r = await request('POST', `${root}/${approvedId}/executar`, body)
      assert.equal(r.status, 409); assert.equal(r.body.code, 'EXECUCAO_DESABILITADA_MODO_REVISAO')
    }
    const after = await row(approvedId)
    assert.deepEqual(after, before)
    const unknown = await request('POST', `${root}/${randomUUID()}/executar`, { hash: 'a'.repeat(64) }); assert.equal(unknown.body.code, 'EXECUCAO_DESABILITADA_MODO_REVISAO')
  })
  await check('Rejeição com motivo e hash é terminal e persistida', async () => {
    const p = (await request('POST', root + '/propostas', manual({ platform: 'google', accountId: 'conta-homologacao-google', campaignId: 'campanha-homologacao-google' }))).body
    const r = await request('POST', `${root}/${p.id}/rejeitar`, { hash: p.hash, reason: 'Sem evidência verificada.' })
    assert.equal(r.body.state, 'rejeitada'); assert.equal((await row(p.id)).record.rejection.reason, 'Sem evidência verificada.')
    assert.equal((await request('POST', `${root}/${p.id}/aprovar`, { hash: p.hash })).body.code, 'ESTADO_NAO_PERMITE_APROVAR')
  })
  await check('Duas aprovações concorrentes da mesma versão: uma grava, outra conflita', async () => {
    const p = (await request('POST', root + '/propostas', manual())).body
    const rs = await Promise.all([request('POST', `${root}/${p.id}/aprovar`, { hash: p.hash }, token('admin', 'revisor-a')), request('POST', `${root}/${p.id}/aprovar`, { hash: p.hash }, token('admin', 'revisor-b'))])
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]); assert.equal((await row(p.id)).revision, 2)
  })
  await check('Banco mantém origem imutável (trigger) e sem DELETE para service_role', async () => {
    await assert.rejects(() => pool.query(`UPDATE campaign_review.proposals SET record=jsonb_set(record,'{payload,origin,verified}','true') WHERE id=$1`, [approvedId]), (e) => e.code === '23514')
    await assert.rejects(() => pool.query('DELETE FROM campaign_review.proposals WHERE id=$1', [approvedId]), (e) => e.code === '42501')
  })
  await check('Restart do PostgreSQL e nova composição preservam a decisão; execução segue recusada', async () => {
    await new Promise((r) => server.close(r)); server = null
    await pool.end(); await cluster.admin.end(); cluster.stop(); cluster.start()
    cluster.admin = new pg.Client(cluster.config); await cluster.admin.connect()
    pool = new pg.Pool({ ...cluster.config, user: 'service_role', max: 4 })
    server = await mount(); port = server.address().port
    const list = await request('GET', root)
    const found = list.body.proposals.find((p) => p.id === approvedId)
    assert.equal(found.state, 'aprovada'); assert.deepEqual(found.history.map((e) => e.state), ['proposta', 'aprovada']); assert.equal(found.approval.actorId, 'revisor-sintetico')
    assert.equal(list.body.proposals.length, 4)
    assert.equal((await request('POST', `${root}/${approvedId}/executar`, { hash: found.hash })).body.code, 'EXECUCAO_DESABILITADA_MODO_REVISAO')
  })
} catch (e) { report.failure = { code: e.code ?? null, message: e.message }; process.exitCode = 1; console.error(e.stack) }
finally {
  if (server) await new Promise((r) => server.close(r))
  if (pool) await pool.end().catch(() => {})
  if (cluster) { await cluster.admin.end().catch(() => {}); try { cluster.stop(); report.stopped = true } catch (e) { report.stopError = e.message; process.exitCode = 1 } }
  fs.writeFileSync(path.join(workspace, 'output', `VIVENZZA_CAMPANHAS_REVIEW_ONLY_HTTP_${run}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.tests.length, failure: report.failure, stopped: report.stopped, network }))
}
