// ACHADO: GET /api/clientes-erp/busca (qualquer usuário autenticado — vendedor,
// financeiro ou admin, sem restrição de papel) devolvia `err.message` bruto no
// corpo da resposta quando a consulta ao Supabase falhava
// (`res.status(500).json({ erro: err.message })`). Erros reais de
// Postgres/PostgREST (violação de constraint, coluna/tabela inválida) trazem
// nome de tabela/constraint e, em `details`, o valor exato que causou o
// conflito — nesta rota isso pode incluir CNPJ/CPF/razão social de cliente
// real. Prova com erro sintético adversarial via mock do client Supabase
// (não depende de derrubar o Postgres de verdade nem de dado real).
//
// Nota de infra (não é o achado desta suíte): o compat client local
// (src/lib/localdev/pgCompatClient.js) não implementa `.or()` — usado por
// esta rota (e por src/routes/fornecedores.js) — então uma chamada real de
// ponta a ponta contra o Postgres local falharia com "...or is not a
// function", mascarando o teste do achado real. Por isso o caminho feliz
// também usa mock: o SELECT em si é lógica pré-existente, não tocada por
// esta correção (que altera só o `catch`).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta
const tokenVendedor = () => jwt.sign(
  { id: 'vendedor-ceb-teste', email: 'vendedor-ceb@teste-ceb.local', role: 'vendedor' },
  process.env.JWT_SECRET
)

function mockClientesErpFrom(resultado) {
  const original = supabase.from
  supabase.from = (table) => {
    if (table !== 'clientes_erp') return original.call(supabase, table)
    const chain = {
      select: () => chain,
      eq: () => chain,
      or: () => chain,
      order: () => chain,
      limit: () => chain,
      then: (resolve) => resolve(resultado),
    }
    return chain
  }
  return () => { supabase.from = original }
}

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/clientes-erp.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/clientes-erp', auth, router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})

after(async () => {
  server?.close()
  await pararAmbienteDeTeste()
})

function chamar(path, token) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'GET', path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('GET /api/clientes-erp/busca — sem token, 401', async () => {
  const r = await chamar('/api/clientes-erp/busca?search=teste', null)
  assert.equal(r.status, 401)
})

test('GET /api/clientes-erp/busca — caminho feliz, vendedor autenticado recebe os clientes encontrados', async (t) => {
  const restaurar = mockClientesErpFrom({
    data: [{ id: 'fake-id-1', legacy_id: 'CEB-1', tipo: 'PJ', razao_social: 'Cliente Teste CEB Ltda', ativo: true }],
    error: null,
  })
  t.after(restaurar)

  const r = await chamar('/api/clientes-erp/busca?search=Cliente%20Teste', tokenVendedor())
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(Array.isArray(r.body))
  assert.equal(r.body[0].razao_social, 'Cliente Teste CEB Ltda')
})

test('GET /api/clientes-erp/busca — erro sintético adversarial no Supabase não vaza detalhe interno pro cliente', async (t) => {
  const erroSintetico = {
    message: 'duplicate key value violates unique constraint "clientes_erp_legacy_id_unique" — Key (legacy_id)=(SEGREDO-INTERNO-9F3A) already exists.',
    details: 'Failing row contains (uuid-sintetico, SEGREDO-INTERNO-9F3A, ...).',
    hint: 'dica-interna-schema-sintetica',
    code: '23505',
  }
  const restaurar = mockClientesErpFrom({ data: null, error: erroSintetico })
  t.after(restaurar)

  const r = await chamar('/api/clientes-erp/busca?search=qualquer', tokenVendedor())
  assert.equal(r.status, 500)
  const corpoBruto = JSON.stringify(r.body)
  assert.ok(!corpoBruto.includes('SEGREDO-INTERNO-9F3A'), 'resposta não pode conter o valor sintético do erro interno')
  assert.ok(!corpoBruto.includes('clientes_erp_legacy_id_unique'), 'resposta não pode vazar nome de constraint/tabela interna')
  assert.ok(!corpoBruto.includes('dica-interna-schema-sintetica'), 'resposta não pode vazar hint interno')
  assert.ok(!corpoBruto.includes('23505'), 'resposta não pode vazar código interno do Postgres')
  assert.equal(r.body.erro, 'Erro ao buscar clientes. Tente novamente.')
})
