// Homologação local do modo SOMENTE REVISÃO: mesmo router e composição de produção
// (createCampaignReviewComposition), sem simulação, sem adapter de Ads, sem cron/jobs.
// Nunca importa index.js nem dotenv. PostgreSQL exclusivo novo (porta 15583) e HTTP 5199.
//   node scripts/campaign-review-homologation.mjs IDENTIFICADOR-NOVO --policy caminho.json [--check]
// --check: sobe, confere GET autenticado e encerra tudo (stop comprovado).
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { startCluster, guardNetwork, pg, workspace } from './lib/campaign-review-cluster.mjs'
process.env.JWT_SECRET = randomUUID() + randomUUID()
delete process.env.API_SECRET_KEY
const { default: express } = await import('express')
const { default: jwt } = await import('jsonwebtoken')
const { createCampaignReviewRouter } = await import('../src/routes/campaign-reviews.js')
const { createCampaignReviewComposition } = await import('../src/lib/campaignReviewComposition.js')
const run = process.argv[2]
const policyArg = process.argv.indexOf('--policy')
if (!run || run.startsWith('--') || policyArg < 0 || !process.argv[policyArg + 1]) throw Error('Uso: IDENTIFICADOR-NOVO --policy caminho.json [--check]')
const policy = JSON.parse(fs.readFileSync(path.resolve(process.argv[policyArg + 1]), 'utf8'))
const checkOnly = process.argv.includes('--check')
const port = 5199, pgPort = 15583, origin = `http://127.0.0.1:${port}`
const root = path.join(workspace, 'vivenzza-campanhas-aprovacoes-front-20261015/dist-campanhas-reviews')
if (!fs.existsSync(path.join(root, 'previews/campanhas-aprovacoes.html'))) throw Error('Build reviews preview first')
const network = guardNetwork(pgPort, () => port)
const cluster = await startCluster(run, pgPort)
let pool, server, closing = false
const stop = async () => {
  if (closing) return
  closing = true
  try {
    if (server) await new Promise((r) => { server.close(r); server.closeAllConnections() })
  } finally {
    try { if (pool) await pool.end() }
    finally { try { await cluster.admin.end() } finally { cluster.stop() } }
  }
  console.log(JSON.stringify({ stopped: true, network }))
}
try {
  pool = new pg.Pool({ ...cluster.config, user: 'service_role', max: 4 })
  const composition = createCampaignReviewComposition({ db: pool, policy })
  const app = express()
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403)
    res.set('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
    res.set('Cache-Control', 'no-store'); next()
  })
  // Sessão admin sintética e efêmera, só em memória, para o revisor local.
  app.post('/preview/session', (req, res) => {
    if (req.headers['x-vivenzza-preview'] !== '1') return res.sendStatus(403)
    res.json({ token: jwt.sign({ id: 'revisor-homologacao', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30m' }) })
  })
  app.use('/api/admin/campaign-reviews', createCampaignReviewRouter(composition))
  app.get('/', (_req, res) => res.sendFile(path.join(root, 'previews/campanhas-aprovacoes.html')))
  app.use(express.static(root))
  server = await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); s.once('error', reject) })
  console.log(JSON.stringify({ homologacao: origin, mode: composition.mode, realExecutor: false, adapter: false, postgresPort: pgPort, run }))
  if (checkOnly) {
    const token = jwt.sign({ id: 'revisor-homologacao', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1m' })
    const { default: http } = await import('node:http')
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/admin/campaign-reviews', headers: { Authorization: `Bearer ${token}`, Host: `127.0.0.1:${port}` } }, (res) => {
        let d = ''; res.on('data', (c) => { d += c }); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(d) }))
      }).on('error', reject)
    })
    console.log(JSON.stringify({ check: { status: body.status, mode: body.mode, capabilities: body.capabilities, proposals: body.proposals?.length } }))
    await stop()
  } else {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop().then(() => process.exit(0)).catch(() => process.exit(1)) })
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (data) => { if (data.trim() === 'stop-preview') stop().then(() => process.exit(0)).catch(() => process.exit(1)) })
  }
} catch (e) { await stop(); throw e }
