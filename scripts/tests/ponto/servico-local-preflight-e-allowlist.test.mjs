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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { aguardarProntidaoLocal, encerrarProcessoLocal } from './_processo-local.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVICO_DIR = path.join(__dirname, '..', '..', '..', 'local-equipamento-service')
const ORIGEM = 'http://localhost:5173'
const API_OK = 'http://127.0.0.1:3999'

let proc, porta, token, configDir, erros = ''

before(async () => {
  const reserva = http.createServer()
  await new Promise((resolve, reject) => { reserva.once('error', reject); reserva.listen(0, '127.0.0.1', resolve) })
  porta = reserva.address().port
  await new Promise((resolve, reject) => reserva.close(e => e ? reject(e) : resolve()))
  configDir = path.join(os.tmpdir(), `meu-ponto-preflight-${crypto.randomBytes(4).toString('hex')}`)
  // Nenhum caso desta suíte precisa de CNG/diálogo. Bloquear a fronteira
  // inclusive nas reproduções de entradas que antes chegavam ao PowerShell.
  const bootstrap = `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(s,c,next){
      if(s==='node:child_process'||s==='child_process')return {url:'mock:processo-externo',shortCircuit:true};
      return next(s,c);
    },load(url,c,next){
      if(url==='mock:processo-externo')return {format:'module',shortCircuit:true,source:"export function execFile(...args){console.error('TESTE_PROCESSO_EXTERNO_BLOQUEADO');args.at(-1)(new Error('processo externo bloqueado pelo teste'))}"};
      return next(url,c);
    }});
    await import(${JSON.stringify(pathToFileURL(path.join(SERVICO_DIR, 'servico.mjs')).href)});
  `
  proc = spawn(process.execPath, ['--input-type=module', '--eval', bootstrap], {
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
  proc.stderr.on('data', (c) => { erros += c.toString() })
  token = await aguardarProntidaoLocal(proc)
})

after(async () => {
  await encerrarProcessoLocal(proc)
  if (configDir) {
    const alvo = path.resolve(configDir)
    assert.equal(path.dirname(alvo), path.resolve(os.tmpdir()))
    assert.match(path.basename(alvo), /^meu-ponto-preflight-[a-f0-9]{8}$/)
    await fs.rm(alvo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
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

test('/cadastrar recusa credenciais na URL antes de criar chave ou contatar backend', async () => {
  for (const url of ['http://usuario:senha@127.0.0.1:3999', 'http://usuario@127.0.0.1:3999', 'http://:senha@127.0.0.1:3999']) {
    const res = await chamar('/cadastrar', {
      method: 'POST', body: { codigoVinculo: 'x', crmApiBaseUrl: url },
      headers: { 'x-ponto-pairing-token': token },
    })
    assert.equal(res.status, 400)
    assert.doesNotMatch(JSON.stringify(res.body), /usuario|senha/)
  }
  assert.doesNotMatch(erros, /TESTE_PROCESSO_EXTERNO_BLOQUEADO/)
})
