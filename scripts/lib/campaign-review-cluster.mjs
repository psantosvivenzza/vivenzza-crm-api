import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, registerHooks } from 'node:module'
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const workspace = path.dirname(repo)
const requireBase = createRequire(path.join(workspace, 'vivenzza-crm-api/package.json'))
const packages = Object.fromEntries(['express', 'jsonwebtoken'].map((p) => [p, pathToFileURL(requireBase.resolve(p)).href]))
registerHooks({ resolve(specifier, context, next) { return packages[specifier] ? { url: packages[specifier], shortCircuit: true } : next(specifier, context) } })
export const pg = (await import(pathToFileURL(path.join(workspace, '.pgtest-cache/node_modules/pg/lib/index.js')).href)).default
export async function startCluster(run, port = 15581) {
  if (!/^[a-z0-9-]+$/.test(run)) throw Error('Unique run id required')
  const dir = path.join(repo, '.localdev', 'campaign-review-' + run)
  if (fs.existsSync(dir)) throw Error('Run directory exists; never reuse blindly')
  const bin = path.join(workspace, 'tools/vivenzza-postgresql-17.11-5/pgsql/bin')
  const runtime = (exe, args, ignore = false) => {
    const r = spawnSync(path.join(bin, exe + '.exe'), args, { encoding: 'utf8', timeout: 30000, windowsHide: true, stdio: ignore ? 'ignore' : 'pipe' })
    if (r.status !== 0) throw Error(`${exe}: ${r.error?.code || r.stderr || r.status}`)
  }
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)) })
  fs.mkdirSync(dir, { recursive: true })
  runtime('initdb', ['-D', dir, '-U', 'postgres', '-E', 'UTF8', '--locale=C', '--auth=trust', '--no-instructions'])
  const start = () => runtime('pg_ctl', ['-D', dir, '-l', path.join(dir, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1`, '-w', 'start'], true)
  const stop = () => runtime('pg_ctl', ['-D', dir, '-m', 'fast', '-w', 'stop'], true)
  start()
  const config = { host: '127.0.0.1', port, database: 'postgres', user: 'postgres', connectionTimeoutMillis: 4000, statement_timeout: 10000 }
  const bootstrap = new pg.Client(config)
  try {
    await bootstrap.connect()
    const identity = (await bootstrap.query("SELECT host(inet_server_addr()) AS host,current_setting('data_directory') AS dir,current_setting('listen_addresses') AS listen")).rows[0]
    if (identity.host !== '127.0.0.1' || path.resolve(identity.dir) !== dir || identity.listen !== '127.0.0.1') throw Error('Cluster identity mismatch')
    await bootstrap.query('CREATE DATABASE campaign_review_synthetic')
    await bootstrap.query('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role LOGIN')
  } catch (e) { await bootstrap.end().catch(() => {}); stop(); throw e }
  await bootstrap.end()
  config.database = 'campaign_review_synthetic'
  const admin = new pg.Client(config); await admin.connect()
  try { await admin.query(fs.readFileSync(path.join(repo, 'supabase/migrations/20261015190408_campaign_review_proposals.sql'), 'utf8')) }
  catch (e) { await admin.end(); stop(); throw e }
  return { admin, config, dir, port, stop, start, runtime }
}
export function guardNetwork(pgPort, httpPort = () => 0) {
  const original = net.Socket.prototype.connect
  const stats = { allowed: 0, blocked: 0, fetchBlocked: 0 }
  net.Socket.prototype.connect = function (...args) {
    const a = Array.isArray(args[0]) ? args[0] : args, value = a[0], obj = value && typeof value === 'object'
    const host = obj ? (value.host ?? value.hostname) : a[1], port = obj ? value.port : value
    if (host !== '127.0.0.1' || !['string', 'number'].includes(typeof port) || ![pgPort, httpPort()].filter(Boolean).includes(Number(port))) { stats.blocked++; throw Error('NETWORK_FORBIDDEN') }
    stats.allowed++; return original.apply(this, args)
  }
  globalThis.fetch = () => { stats.fetchBlocked++; throw Error('FETCH_FORBIDDEN') }
  return stats
}
