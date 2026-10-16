// Explicit local synthetic entry point: never imports index.js or dotenv.
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { startCluster, guardNetwork, pg, workspace } from './lib/campaign-review-cluster.mjs'
import { initializeSyntheticTargets, createCampaignReviewSimulation } from './lib/campaign-review-simulation.mjs'
process.env.JWT_SECRET = randomUUID() + randomUUID()
delete process.env.API_SECRET_KEY
const { default: express } = await import('express')
const { default: jwt } = await import('jsonwebtoken')
const { createCampaignReviewRouter } = await import('../src/routes/campaign-reviews.js')
const run = process.argv[2]
if (!run) throw Error('Unique preview run id required')
const port = 5198, origin = `http://127.0.0.1:${port}`
const root = path.join(workspace, 'vivenzza-campanhas-aprovacoes-front-20261015/dist-campanhas-reviews')
if (!fs.existsSync(path.join(root, 'previews/campanhas-aprovacoes.html'))) throw Error('Build reviews preview first')
const network = guardNetwork(15581, () => port)
const cluster = await startCluster(run)
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
  await initializeSyntheticTargets(cluster.admin)
  pool = new pg.Pool({ ...cluster.config, user: 'service_role', max: 4 })
  const sim = await createCampaignReviewSimulation(pool)
  for (const platform of ['meta', 'google']) await sim.simulation(platform, { id: 'admin-preview-sintetico', role: 'admin' })
  const app = express()
  app.use((req, res, next) => {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403)
    res.set('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'")
    res.set('Cache-Control', 'no-store'); next()
  })
  app.post('/preview/session', (req, res) => {
    if (req.headers['x-vivenzza-preview'] !== '1') return res.sendStatus(403)
    res.json({ token: jwt.sign({ id: 'admin-preview-sintetico', role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '30m' }) })
  })
  app.use('/api/admin/campaign-reviews', createCampaignReviewRouter({ workflow: sim.workflow, simulation: sim.simulation }))
  app.get('/', (_req, res) => res.sendFile(path.join(root, 'previews/campanhas-aprovacoes.html')))
  app.use(express.static(root))
  server = await new Promise((resolve, reject) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); s.once('error', reject) })
  console.log(JSON.stringify({ preview: origin, synthetic: true, realExecutor: false, postgresPort: 15581, run }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stop().then(() => process.exit(0)).catch(() => process.exit(1)) })
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data) => { if (data.trim() === 'stop-preview') stop().then(() => process.exit(0)).catch(() => process.exit(1)) })
} catch (e) { await stop(); throw e }
