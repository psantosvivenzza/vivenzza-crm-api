// Serviço local de equipamento — preflight CORS, allowlist de API e /status.
// Não precisa de CNG nem de banco: só sobe o serviço real como processo filho
// e conversa HTTP com ele. Nenhuma das rotas exercitadas aqui chega ao CNG
// (todas as respostas são geradas antes de qualquer chamada PowerShell).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVICO_DIR = path.join(__dirname, '..', '..', '..', 'local-equipamento-service')
const ORIGEM = 'http://localhost:5173'
const API_OK = 'http://127.0.0.1:3999'

let proc, porta, token, configDir

before(async () => {
  porta = 47000 + Math.floor(Math.random() * 900)
  configDir = path.join(os.tmpdir(), `meu-ponto-preflight-${crypto.randomBytes(4).toString('hex')}`)
  proc = spawn('node', ['servico.mjs'], {
    cwd: SERVICO_DIR,
    env: {
      ...process.env,
      PONTO_LOCAL_SERVICO_PORTA: String(porta),
      PONTO_LOCAL_SERVICO_CONFIG_DIR: configDir,
      PONTO_LOCAL_SERVICO_ORIGENS_PERMITIDAS: ORIGEM,
      PONTO_LOCAL_SERVICO_API_PERMITIDAS: API_OK,
    },
    windowsHide: true,
  })
  await new Promise((resolve, reject) => {
    let saida = ''
    const t = setTimeout(() => reject(new Error('timeout subindo serviço local')), 15000)
    proc.stdout.on('data', (c) => {
      saida += c.toString()
      const m = saida.match(/token de pareamento.*?:\s*(\S+)/)
      if (m && saida.includes('escutando em')) { clearTimeout(t); token = m[1]; resolve() }
    })
    proc.on('error', reject)
  })
})

after(async () => {
  if (proc) {
    proc.kill()
    await new Promise((resolve) => proc.once('exit', resolve))
  }
  if (configDir) await fs.rm(configDir, { recursive: true, force: true }).catch(() => {})
})

function chamar(caminho, { method = 'GET', body, origin = ORIGEM, host = `127.0.0.1:${porta}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null
    const h = { host, ...headers }
    if (origin) h.origin = origin
    if (payload) h['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: caminho, headers: h }, (res) => {
      let d = ''
      res.on('data', (c) => { d += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d ? JSON.parse(d) : null }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

test('preflight OPTIONS de origem permitida: 204 com headers CORS e Private Network', async () => {
  for (const rota of ['/status', '/cadastrar', '/assinar-marcacao']) {
    const res = await chamar(rota, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } })
    assert.equal(res.status, 204, rota)
    assert.equal(res.headers['access-control-allow-origin'], ORIGEM)
    assert.match(res.headers['access-control-allow-headers'], /x-ponto-pairing-token/)
    assert.equal(res.headers['access-control-allow-private-network'], 'true')
  }
})

test('preflight não exige token, mas continua exigindo Origin permitida', async () => {
  const res = await chamar('/cadastrar', { method: 'OPTIONS', origin: 'https://site-malicioso.example' })
  assert.equal(res.status, 403)
  assert.equal(res.headers['access-control-allow-origin'], undefined)
  const semOrigin = await chamar('/cadastrar', { method: 'OPTIONS', origin: null })
  assert.equal(semOrigin.status, 403)
})

test('preflight com Host inesperado (DNS rebinding) é rejeitado', async () => {
  const res = await chamar('/cadastrar', { method: 'OPTIONS', host: 'evil.example' })
  assert.equal(res.status, 403)
})

test('preflight em rota inexistente cai em 404, sem CORS', async () => {
  const res = await chamar('/qualquer-outra', { method: 'OPTIONS' })
  assert.equal(res.status, 404)
})

test('/status informa pareado=false e equipamentoId=null antes do cadastro', async () => {
  const res = await chamar('/status')
  assert.equal(res.status, 200)
  assert.equal(res.body.pareado, false)
  assert.equal(res.body.equipamentoId, null)
})

test('/cadastrar recusa crmApiBaseUrl fora da allowlist, antes de tocar no CNG', async () => {
  for (const url of ['https://api-falsa.example', 'http://127.0.0.1:3998', 'nao-e-url']) {
    const res = await chamar('/cadastrar', {
      method: 'POST',
      body: { codigoVinculo: 'x', crmApiBaseUrl: url },
      headers: { 'x-ponto-pairing-token': token },
    })
    assert.equal(res.status, 400, url)
    assert.match(res.body.erro, /lista de APIs permitidas/)
  }
})

test('/cadastrar continua exigindo token de pareamento antes de qualquer outra coisa', async () => {
  const res = await chamar('/cadastrar', { method: 'POST', body: { codigoVinculo: 'x', crmApiBaseUrl: API_OK } })
  assert.equal(res.status, 401)
})
