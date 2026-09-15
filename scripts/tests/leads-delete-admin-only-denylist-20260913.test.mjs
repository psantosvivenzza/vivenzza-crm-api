// Auditoria adversarial de mounts/autorização de 2026-09-13 — achado
// independente das PRs #87 (fix/auth-login-rate-limit-ausente-20260912), #88
// (fix/auth-senha-middleware-ausente-20260912) e #89
// (fix/avaliacoes-admin-role-ausente-20260913): nenhuma delas toca
// src/routes/leads.js.
//
// DELETE /api/leads/:id está comentado como "(admin only)" no próprio
// arquivo, mas o gate real é `if (req.user.role === 'vendedor') return 403`
// — uma DENYLIST, não uma allowlist. Isso é exatamente o antipadrão que
// middleware/auth.js já documenta ter sido abandonado nas rotas financeiras
// em 2026-09-07 ("diferente do gate de posse anterior (role==='vendedor'),
// que deixava passar qualquer coisa que não fosse exatamente 'vendedor'") —
// só que aqui, em leads.js, o antipadrão nunca foi corrigido.
//
// Consequência real: `usuarios.role` aceita 'admin' | 'vendedor' |
// 'financeiro' (routes/usuarios.js, desde 3c77f66). Um usuário com role
// 'financeiro' (papel introduzido só para operações financeiras — ver
// comentário em routes/usuarios.js: "não concede adminOnly em nenhuma outra
// rota") passa direto pelo `!== 'vendedor'` e consegue apagar QUALQUER lead
// do funil comercial, apesar do próprio comentário da rota dizer "admin
// only". Todo outro "admin only" do código (pedidos.js, cobrancas.js,
// comissoes.js, nfe-entradas.js, notifications.js, usuarios.js,
// relatorios.js) usa `role !== 'admin'` ou o middleware `adminOnly` — leads.js
// é o único outlier.
//
// Corrigido em src/routes/leads.js: `if (req.user.role === 'vendedor')` →
// `if (req.user.role !== 'admin')` na DELETE /:id.
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
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-leads-delete-nao-e-producao'

let servidor, porta, supabase
const idsCriados = []

before(async () => {
  const expressModule = await import('express')
  const express = expressModule.default
  const leadsRouter = (await import('../../src/routes/leads.js')).default
  const { auth } = await import('../../src/middleware/auth.js')
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))

  const app = express()
  app.use(express.json())
  // Mesmo mount de src/index.js: app.use('/api/leads', auth, leadsRouter) —
  // sem adminOnly no mount, a checagem "admin only" tem que vir de dentro
  // do próprio router (é exatamente essa checagem interna que está quebrada).
  app.use('/api/leads', auth, leadsRouter)

  servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  porta = servidor.address().port
})

after(async () => {
  if (idsCriados.length) await supabase.from('leads').delete().in('id', idsCriados)
  await new Promise((resolve) => servidor.close(resolve))
})

function chamar(method, caminho, { token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: caminho, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function criarLead(sufixo) {
  const { data, error } = await supabase
    .from('leads')
    .insert({ nome: `Lead Teste ${sufixo}`, telefone: `5551999${String(Date.now()).slice(-6)}`, origem: 'manual' })
    .select('id')
    .single()
  if (error) throw error
  idsCriados.push(data.id)
  return data.id
}

async function leadExiste(id) {
  const { data } = await supabase.from('leads').select('id').eq('id', id).maybeSingle()
  return !!data
}

const tokenVendedor = () => jwt.sign({ id: 'vendedor-teste-1', email: 'vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
const tokenFinanceiro = () => jwt.sign({ id: 'financeiro-teste-1', email: 'financeiro@teste.com', role: 'financeiro' }, process.env.JWT_SECRET)
const tokenAdmin = () => jwt.sign({ id: 'admin-teste-1', email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)

test('sem token: DELETE /api/leads/:id é recusado (401), lead não é removido', async () => {
  const id = await criarLead('sem-token')
  const r = await chamar('DELETE', `/api/leads/${id}`)
  assert.equal(r.status, 401)
  assert.ok(await leadExiste(id), 'sem autenticação, o lead não pode ser removido')
})

test('token de vendedor: 403, lead não é removido (contrato "admin only" respeitado)', async () => {
  const id = await criarLead('vendedor-nao-pode')
  const r = await chamar('DELETE', `/api/leads/${id}`, { token: tokenVendedor() })
  assert.equal(r.status, 403)
  assert.ok(await leadExiste(id), 'vendedor não pode apagar lead — nunca foi o achado, serve de controle')
})

test('token de financeiro (papel introduzido em 2026-09-07 só para /api/financeiro): DELETE /api/leads/:id tem que recusar (403) — regressão do achado 2026-09-13', async () => {
  const id = await criarLead('financeiro-nao-pode')
  const r = await chamar('DELETE', `/api/leads/${id}`, { token: tokenFinanceiro() })
  assert.equal(r.status, 403, 'a rota é documentada como "(admin only)" — financeiro não é admin e precisa ser recusado')
  assert.ok(await leadExiste(id), 'lead precisa continuar existindo depois da negação — nenhum estado no banco pode mudar')
})

test('token de admin: 204, lead é removido de verdade (controle positivo — a correção não quebra o caminho legítimo)', async () => {
  const id = await criarLead('admin-pode')
  const r = await chamar('DELETE', `/api/leads/${id}`, { token: tokenAdmin() })
  assert.equal(r.status, 204)
  assert.ok(!(await leadExiste(id)), 'admin precisa conseguir remover de verdade')
})
