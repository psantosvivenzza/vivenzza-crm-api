// Auditoria adversarial de IDOR/posse por objeto de 2026-09-13 — achado
// independente das PRs #87-#91 (domínio auth/avaliacoes/leads-delete/
// meta-report — nenhuma toca src/routes/contatos.js), do piloto "Meu Ponto"
// (branch codex/meu-ponto-backend-20260910 e PRs #78/#81-86) e das mudanças
// financeiras já publicadas em main (92b233c/3c77f66) — nenhuma delas toca
// este arquivo.
//
// src/routes/leads.js e src/routes/tarefas.js estabelecem o padrão de posse
// já existente no código: vendedor só acessa/edita/remove objetos onde
// responsavel_id === req.user.id; qualquer outro papel (admin, financeiro)
// vê tudo. contatos.js está montado com o mesmo `auth` simples (sem
// adminOnly) em src/index.js, e cada contato pertence a exatamente um lead
// (lead_id), populado automaticamente na criação do lead (leads.js) e usado
// pra filtrar (`if (lead_id) query = query.eq('lead_id', lead_id)`) — ou
// seja, o próprio código já trata contato como dado do lead. Mas
// GET /:id, PUT /:id e DELETE /:id não tinham NENHUMA checagem de posse, e
// GET / (listagem) não escopava por vendedor mesmo sem lead_id no
// querystring — um vendedor conseguia ler/editar/apagar contato de
// QUALQUER lead (inclusive de outro vendedor), e listar todos os contatos
// da empresa (nome, email, telefone, empresa, cargo, observações).
//
// Corrigido em src/routes/contatos.js: GET /, GET /:id, PUT /:id e
// DELETE /:id agora escopam por posse do lead dono do contato quando
// req.user.role === 'vendedor', no mesmo estilo (queries de pre-check
// separadas) já usado em leads.js/tarefas.js. Contato sem lead_id (órfão)
// ou cujo lead não existe mais é negado (403) por padrão — fail-closed,
// não há decisão de negócio dizendo que vendedor deveria herdar contato
// órfão.
//
// Postgres exclusivo desta suíte (nunca 5432/5433/vivenzza_dev, nunca
// produção): porta/banco definidos via LOCAL_PG_PORT/LOCAL_PG_DATABASE no
// ambiente antes de rodar (ver scripts/localdb-start.mjs/localdb-reset.mjs).
// scripts/localdb/schema-baseline/008_contatos.sql adiciona a tabela
// `contatos` ao baseline local (existe em produção, nunca foi versionada).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-contatos-ownership-nao-e-producao'

let servidor, porta, supabase
const leadIdsCriados = []
const contatoIdsCriados = []
const usuarioIdsCriados = []
let VENDEDOR_A, VENDEDOR_B

before(async () => {
  const expressModule = await import('express')
  const express = expressModule.default
  const contatosRouter = (await import('../../src/routes/contatos.js')).default
  const { auth } = await import('../../src/middleware/auth.js')
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))

  const app = express()
  app.use(express.json())
  // Mesmo mount de src/index.js: app.use('/api/contatos', auth, contatosRouter).
  app.use('/api/contatos', auth, contatosRouter)

  servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  porta = servidor.address().port

  // leads.responsavel_id é uuid REFERENCES usuarios(id) — precisa de linhas
  // reais na tabela (não basta um id arbitrário como string).
  const sufixo = Date.now()
  const criarUsuario = async (nome) => {
    const { data, error } = await supabase
      .from('usuarios')
      .insert({ nome, email: `${nome}-${sufixo}@teste.com`, role: 'vendedor' })
      .select('id')
      .single()
    if (error) throw error
    usuarioIdsCriados.push(data.id)
    return data.id
  }
  VENDEDOR_A = await criarUsuario('vendedor-a-ownership-teste')
  VENDEDOR_B = await criarUsuario('vendedor-b-ownership-teste')
})

after(async () => {
  if (contatoIdsCriados.length) await supabase.from('contatos').delete().in('id', contatoIdsCriados)
  if (leadIdsCriados.length) await supabase.from('leads').delete().in('id', leadIdsCriados)
  if (usuarioIdsCriados.length) await supabase.from('usuarios').delete().in('id', usuarioIdsCriados)
  await new Promise((resolve) => servidor.close(resolve))
})

function chamar(method, caminho, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    if (body) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: caminho, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function criarLead(sufixo, responsavelId) {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      nome: `Lead Teste ${sufixo}`,
      telefone: `5551999${String(Date.now()).slice(-6)}`,
      origem: 'manual',
      responsavel_id: responsavelId,
    })
    .select('id')
    .single()
  if (error) throw error
  leadIdsCriados.push(data.id)
  return data.id
}

async function criarContato(sufixo, leadId) {
  const { data, error } = await supabase
    .from('contatos')
    .insert({ nome: `Contato Teste ${sufixo}`, email: `contato-${sufixo}@teste.com`, lead_id: leadId })
    .select('id')
    .single()
  if (error) throw error
  contatoIdsCriados.push(data.id)
  return data.id
}

async function contatoAtual(id) {
  const { data } = await supabase.from('contatos').select('*').eq('id', id).maybeSingle()
  return data
}

const tokenVendedor = (id) => jwt.sign({ id, email: `${id}@teste.com`, role: 'vendedor' }, process.env.JWT_SECRET)
const tokenAdmin = () => jwt.sign({ id: 'admin-teste-1', email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)

test('GET /api/contatos/:id — vendedor dono do lead acessa normalmente (controle positivo)', async () => {
  const leadId = await criarLead('get-dono', VENDEDOR_A)
  const contatoId = await criarContato('get-dono', leadId)
  const r = await chamar('GET', `/api/contatos/${contatoId}`, { token: tokenVendedor(VENDEDOR_A) })
  assert.equal(r.status, 200)
  assert.equal(r.body.id, contatoId)
})

test('GET /api/contatos/:id — vendedor de outro lead recebe 403 (achado: antes não havia checagem nenhuma)', async () => {
  const leadId = await criarLead('get-outro', VENDEDOR_A)
  const contatoId = await criarContato('get-outro', leadId)
  const r = await chamar('GET', `/api/contatos/${contatoId}`, { token: tokenVendedor(VENDEDOR_B) })
  assert.equal(r.status, 403)
})

test('PUT /api/contatos/:id — vendedor de outro lead recebe 403, contato não é alterado', async () => {
  const leadId = await criarLead('put-outro', VENDEDOR_A)
  const contatoId = await criarContato('put-outro', leadId)
  const antes = await contatoAtual(contatoId)

  const r = await chamar('PUT', `/api/contatos/${contatoId}`, {
    token: tokenVendedor(VENDEDOR_B),
    body: { nome: 'Nome Alterado Indevidamente' },
  })
  assert.equal(r.status, 403)

  const depois = await contatoAtual(contatoId)
  assert.equal(depois.nome, antes.nome, 'contato não pode ser alterado por vendedor sem posse do lead')
})

test('DELETE /api/contatos/:id — vendedor de outro lead recebe 403, contato continua no banco', async () => {
  const leadId = await criarLead('delete-outro', VENDEDOR_A)
  const contatoId = await criarContato('delete-outro', leadId)

  const r = await chamar('DELETE', `/api/contatos/${contatoId}`, { token: tokenVendedor(VENDEDOR_B) })
  assert.equal(r.status, 403)
  assert.ok(await contatoAtual(contatoId), 'contato precisa continuar existindo depois da negação')
})

test('GET /api/contatos (listagem) — vendedor só vê contatos dos próprios leads', async () => {
  const leadProprio = await criarLead('lista-proprio', VENDEDOR_A)
  const contatoProprio = await criarContato('lista-proprio', leadProprio)
  const leadAlheio = await criarLead('lista-alheio', VENDEDOR_B)
  const contatoAlheio = await criarContato('lista-alheio', leadAlheio)

  const r = await chamar('GET', '/api/contatos?limit=100', { token: tokenVendedor(VENDEDOR_A) })
  assert.equal(r.status, 200)
  const ids = r.body.data.map((c) => c.id)
  assert.ok(ids.includes(contatoProprio), 'contato do próprio lead precisa aparecer')
  assert.ok(!ids.includes(contatoAlheio), 'contato de lead de outro vendedor não pode vazar na listagem')
})

test('contato órfão (sem lead_id) — vendedor recebe 403 por padrão fail-closed', async () => {
  const contatoId = await criarContato('orfao', null)
  const r = await chamar('GET', `/api/contatos/${contatoId}`, { token: tokenVendedor(VENDEDOR_A) })
  assert.equal(r.status, 403)
})

test('admin: GET/PUT/DELETE continuam funcionando em contato de qualquer vendedor (caminho legítimo preservado)', async () => {
  const leadId = await criarLead('admin-ok', VENDEDOR_A)
  const contatoId = await criarContato('admin-ok', leadId)

  const rGet = await chamar('GET', `/api/contatos/${contatoId}`, { token: tokenAdmin() })
  assert.equal(rGet.status, 200)

  const rPut = await chamar('PUT', `/api/contatos/${contatoId}`, { token: tokenAdmin(), body: { nome: 'Editado pelo Admin' } })
  assert.equal(rPut.status, 200)
  assert.equal((await contatoAtual(contatoId)).nome, 'Editado pelo Admin')

  const rDelete = await chamar('DELETE', `/api/contatos/${contatoId}`, { token: tokenAdmin() })
  assert.equal(rDelete.status, 204)
  assert.equal(await contatoAtual(contatoId), null)
})

test('sem token: 401 em todas as rotas, nenhum estado alterado', async () => {
  const leadId = await criarLead('sem-token', VENDEDOR_A)
  const contatoId = await criarContato('sem-token', leadId)

  const rGet = await chamar('GET', `/api/contatos/${contatoId}`)
  assert.equal(rGet.status, 401)

  const rPut = await chamar('PUT', `/api/contatos/${contatoId}`, { body: { nome: 'x' } })
  assert.equal(rPut.status, 401)

  const rDelete = await chamar('DELETE', `/api/contatos/${contatoId}`)
  assert.equal(rDelete.status, 401)

  assert.ok(await contatoAtual(contatoId), 'nenhuma chamada sem autenticação pode alterar o banco')
})
