// POST /api/admin/meta-report — antes desta correção, o gate de auth (em
// src/index.js) comparava direto `authorization !== \`Bearer ${process.env
// .API_SECRET_KEY}\`` sem checar se API_SECRET_KEY estava configurada.
// Diferente do padrão fail-closed + timingSafeEqual já usado no resto do
// repo (webhookAuth.js, aiWorkerAuth.js), essa comparação virava
// `Bearer undefined` quando o segredo não estava definido — um chamador
// mandando esse valor literal era aceito como autorizado.
//
// Reproduzido isoladamente ANTES desta correção (fora da suíte, não
// commitado): copiando a condição literal de src/index.js e chamando com
// API_SECRET_KEY ausente + header "Bearer undefined", o gate antigo
// retornava "autorizado". Este arquivo testa a função extraída
// (metaReportAuthValido, em src/middleware/metaReportAuth.js) e o router
// completo (src/routes/admin-meta-report.js), com o job real injetado por
// um dublê — nenhuma chamada de rede real (Meta/Google/WhatsApp) e nenhum
// banco envolvido, já que esta rota nunca tocou Postgres/Supabase.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { metaReportAuthValido } from '../../src/middleware/metaReportAuth.js'
import { criarAdminMetaReportRouter } from '../../src/routes/admin-meta-report.js'

test('metaReportAuthValido — unitário, sem rede/DB', async (t) => {
  await t.test('vulnerabilidade original: com secret ausente, "Bearer undefined" NÃO é mais aceito', () => {
    delete process.env.API_SECRET_KEY
    assert.equal(metaReportAuthValido('Bearer undefined'), false)
  })

  await t.test('fail-closed: sem API_SECRET_KEY configurada, nenhum header é aceito', () => {
    delete process.env.API_SECRET_KEY
    assert.equal(metaReportAuthValido('Bearer qualquer-coisa'), false)
    assert.equal(metaReportAuthValido(''), false)
    assert.equal(metaReportAuthValido(undefined), false)
  })

  await t.test('secret configurada: token correto aceito, incorreto recusado', () => {
    process.env.API_SECRET_KEY = 'segredo-sintetico-teste'
    assert.equal(metaReportAuthValido('Bearer segredo-sintetico-teste'), true)
    assert.equal(metaReportAuthValido('Bearer segredo-errado'), false)
    assert.equal(metaReportAuthValido('Bearer '), false)
    assert.equal(metaReportAuthValido(undefined), false)
    delete process.env.API_SECRET_KEY
  })
})

test('POST /api/admin/meta-report (router real, job dublê) — end-to-end sem rede/DB', async (t) => {
  let server, porta, chamadasJob

  before(async () => {
    process.env.API_SECRET_KEY = 'segredo-sintetico-e2e'
    chamadasJob = []
    const runMetaReportFake = async (args) => {
      chamadasJob.push(args)
      return { enviado: true, sintetico: true }
    }

    const express = (await import('express')).default
    const app = express()
    app.use(express.json())
    app.use('/api/admin/meta-report', criarAdminMetaReportRouter({ runMetaReport: runMetaReportFake }))
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    porta = server.address().port
  })

  after(async () => {
    server?.close()
    delete process.env.API_SECRET_KEY
  })

  function chamar(authorization) {
    return new Promise((resolve, reject) => {
      const headers = {}
      if (authorization !== undefined) headers.authorization = authorization
      const req = http.request({ host: '127.0.0.1', port: porta, method: 'POST', path: '/api/admin/meta-report', headers }, (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  await t.test('cenário do achado: header literal "Bearer undefined" é recusado (401), job NUNCA é chamado', async () => {
    const r = await chamar('Bearer undefined')
    assert.equal(r.status, 401)
    assert.equal(chamadasJob.length, 0, 'runMetaReport não pode ter sido chamado numa requisição negada')
  })

  await t.test('sem header nenhum: 401, job não chamado', async () => {
    const r = await chamar(undefined)
    assert.equal(r.status, 401)
    assert.equal(chamadasJob.length, 0)
  })

  await t.test('secret correta: 200, job chamado exatamente uma vez (dublê, sem rede real)', async () => {
    const r = await chamar('Bearer segredo-sintetico-e2e')
    assert.equal(r.status, 200, JSON.stringify(r.body))
    assert.equal(r.body.ok, true)
    assert.equal(chamadasJob.length, 1)
  })
})
