// Auditoria adversarial de 2026-09-13 — achado independente das PRs #87/#88
// (fora do domínio auth): src/index.js exige `auth, adminOnly` em TODO outro
// /api/admin/* (campanhas, google-ads, evolution-health, erp), exceto
// /api/admin/avaliacoes, que montava só `auth` — e o próprio router
// (avaliacoes-admin.js) não fazia nenhuma checagem de role internamente
// (diferente de admin.js, cujo /backup tem `adminOnly` inline mesmo com o
// mesmo mount raso). Na prática, qualquer usuário autenticado (vendedor,
// financeiro etc.) conseguia listar a fila de moderação, aprovar e apagar
// avaliações da loja — que alimentam o widget público em /api/avaliacoes.
//
// Corrigido em src/index.js: `app.use('/api/admin/avaliacoes', auth,
// adminOnly, avaliacoesAdminRouter)`.
//
// Postgres exclusivo desta suíte (nunca 5432/5433/vivenzza_dev, nunca
// produção): porta/banco definidos via LOCAL_PG_PORT/LOCAL_PG_DATABASE no
// ambiente antes de rodar (ver scripts/localdb-start.mjs/localdb-reset.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-avaliacoes-admin-nao-e-producao'

let servidor, porta, supabase
let tokenVendedor, tokenAdmin
const idsCriados = []

before(async () => {
  const expressModule = await import('express')
  const express = expressModule.default
  const { auth, adminOnly } = await import('../../src/middleware/auth.js')
  const avaliacoesAdminRouter = (await import('../../src/routes/avaliacoes-admin.js')).default
  const avaliacoesRouter = (await import('../../src/routes/avaliacoes.js')).default
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))

  const app = express()
  app.use(express.json())
  // Mesmo mount de src/index.js (após a correção): auth + adminOnly no
  // admin, público sem auth na listagem/criação.
  app.use('/api/admin/avaliacoes', auth, adminOnly, avaliacoesAdminRouter)
  app.use('/api/avaliacoes', avaliacoesRouter)

  servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  porta = servidor.address().port

  tokenVendedor = jwt.sign({ id: 'vendedor-teste-1', email: 'vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenAdmin = jwt.sign({ id: 'admin-teste-1', email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)
})

after(async () => {
  if (idsCriados.length) await supabase.from('avaliacoes_loja').delete().in('id', idsCriados)
  await new Promise((resolve) => servidor.close(resolve))
})

function chamar(method, caminho, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: caminho, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

async function criarAvaliacaoPendente(sufixo) {
  const { data, error } = await supabase
    .from('avaliacoes_loja')
    .insert({
      nome_cliente: `Cliente Teste ${sufixo}`,
      nota: 5,
      comentario: `Comentário de teste ${sufixo} — não real.`,
      aprovado: false,
    })
    .select('id')
    .single()
  if (error) throw error
  idsCriados.push(data.id)
  return data.id
}

test('sem token: GET /api/admin/avaliacoes/pendentes é recusado (401), nunca vaza fila de moderação', async () => {
  const r = await chamar('GET', '/api/admin/avaliacoes/pendentes')
  assert.equal(r.status, 401)
})

test('token de vendedor (role != admin): 403 em toda rota de moderação, estado no banco não muda (regressão do achado 2026-09-13)', async (t) => {
  const id = await criarAvaliacaoPendente('vendedor-nao-pode')

  await t.test('GET pendentes: 403, não lista a fila pra quem não é admin', async () => {
    const r = await chamar('GET', '/api/admin/avaliacoes/pendentes', { token: tokenVendedor })
    assert.equal(r.status, 403)
  })

  await t.test('PATCH :id/aprovar: 403, avaliação continua não aprovada', async () => {
    const r = await chamar('PATCH', `/api/admin/avaliacoes/${id}/aprovar`, { token: tokenVendedor })
    assert.equal(r.status, 403)

    const { data } = await supabase.from('avaliacoes_loja').select('aprovado').eq('id', id).single()
    assert.equal(data.aprovado, false, 'vendedor não pode aprovar avaliação — isso publicaria no widget público')
  })

  await t.test('DELETE :id: 403, avaliação não é removida', async () => {
    const r = await chamar('DELETE', `/api/admin/avaliacoes/${id}`, { token: tokenVendedor })
    assert.equal(r.status, 403)

    const { data } = await supabase.from('avaliacoes_loja').select('id').eq('id', id).maybeSingle()
    assert.ok(data, 'avaliação não pode ser removida por quem não é admin')
  })
})

test('token de admin: fluxo completo de moderação funciona (controle positivo — a correção não quebra o caminho legítimo)', async (t) => {
  const id = await criarAvaliacaoPendente('admin-pode')

  await t.test('GET pendentes: 200, avaliação criada aparece na fila', async () => {
    const r = await chamar('GET', '/api/admin/avaliacoes/pendentes', { token: tokenAdmin })
    assert.equal(r.status, 200)
    assert.ok(r.body.avaliacoes.some((a) => a.id === id))
  })

  await t.test('PATCH :id/aprovar: 200, e a avaliação passa a aparecer em GET /api/avaliacoes (público)', async () => {
    const r = await chamar('PATCH', `/api/admin/avaliacoes/${id}/aprovar`, { token: tokenAdmin })
    assert.equal(r.status, 200)

    const publica = await chamar('GET', '/api/avaliacoes')
    assert.equal(publica.status, 200)
    assert.ok(publica.body.avaliacoes.some((a) => a.id === id), 'avaliação aprovada por admin deve aparecer no widget público')
  })

  await t.test('DELETE :id: 200, remove de verdade', async () => {
    const r = await chamar('DELETE', `/api/admin/avaliacoes/${id}`, { token: tokenAdmin })
    assert.equal(r.status, 200)

    const { data } = await supabase.from('avaliacoes_loja').select('id').eq('id', id).maybeSingle()
    assert.equal(data, null)
  })
})
