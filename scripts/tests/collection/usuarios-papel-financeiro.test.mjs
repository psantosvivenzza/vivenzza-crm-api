// Suporte formal ao papel "financeiro" (decisão de 2026-09-07) em
// /api/usuarios: valida role contra lista fechada (admin/vendedor/financeiro)
// e confirma que não existe caminho de auto-elevação de papel. Rotas reais,
// Postgres local, dados sintéticos. Nenhum usuário real tocado.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta
let idAdmin, idVendedorA
let tokenAdmin, tokenVendedorA
const criados = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const sufixo = Date.now()
  async function criarUsuarioDeTeste(role, rotulo) {
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste upf)`, email: `${rotulo}-${sufixo}@teste-upf.local`, role, ativo: true, senha_hash: 'x' })
      .select('id').single()
    if (error) throw error
    return data.id
  }
  idAdmin = await criarUsuarioDeTeste('admin', 'admin')
  idVendedorA = await criarUsuarioDeTeste('vendedor', 'vendedor-a')

  tokenAdmin = jwt.sign({ id: idAdmin, email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)
  tokenVendedorA = jwt.sign({ id: idVendedorA, email: 'a@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/usuarios.js')).default
  const authRouter = (await import('../../../src/routes/auth.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/usuarios', auth, router)
  app.use('/api/auth', authRouter)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})
after(async () => {
  server?.close()
  await supabase.from('usuarios').delete().in('id', [idAdmin, idVendedorA, ...criados])
  await pararAmbienteDeTeste()
})

function chamar(method, path, { token = tokenAdmin, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` }
    if (body) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: porta, method, path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function buscarUsuario(id) {
  const { data, error } = await supabase.from('usuarios').select('id, role').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

test('POST /api/usuarios — validação de role contra lista fechada', async (tSuite) => {
  await tSuite.test('admin cria usuário com role="financeiro" com sucesso', async () => {
    const r = await chamar('POST', '/api/usuarios', {
      token: tokenAdmin,
      body: { nome: 'Financeiro Teste', email: `financeiro-novo-${Date.now()}@teste-upf.local`, senha: 'senha123456', role: 'financeiro' },
    })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.role, 'financeiro')
    criados.push(r.body.id)
  })

  await tSuite.test('admin tenta criar usuário com role inválida (string arbitrária) — 400, nada é criado', async () => {
    const email = `invalido-${Date.now()}@teste-upf.local`
    const r = await chamar('POST', '/api/usuarios', {
      token: tokenAdmin,
      body: { nome: 'X', email, senha: 'senha123456', role: 'super-hacker' },
    })
    assert.equal(r.status, 400)
    const { data } = await supabase.from('usuarios').select('id').eq('email', email).maybeSingle()
    assert.equal(data, null, 'nenhum usuário deveria ter sido criado com role inválida')
  })

  await tSuite.test('vendedor não consegue criar usuário nenhum (adminOnly na rota, antes mesmo da validação de role)', async () => {
    const r = await chamar('POST', '/api/usuarios', {
      token: tokenVendedorA,
      body: { nome: 'X', email: `vendedor-tentou-${Date.now()}@teste-upf.local`, senha: 'senha123456', role: 'admin' },
    })
    assert.equal(r.status, 403)
  })
})

test('PATCH /api/usuarios/:id — validação de role + nenhum caminho de auto-elevação', async (tSuite) => {
  await tSuite.test('admin muda role de um usuário existente pra "financeiro"', async () => {
    const email = `alvo-${Date.now()}@teste-upf.local`
    const { data: alvo } = await supabase.from('usuarios').insert({ nome: 'Alvo', email, role: 'vendedor', ativo: true, senha_hash: 'x' }).select('id').single()
    criados.push(alvo.id)

    const r = await chamar('PATCH', `/api/usuarios/${alvo.id}`, { token: tokenAdmin, body: { role: 'financeiro' } })
    assert.equal(r.status, 200)
    assert.equal(r.body.role, 'financeiro')
  })

  await tSuite.test('admin tenta gravar role inválida num usuário existente — 400, role não muda', async () => {
    const email = `alvo2-${Date.now()}@teste-upf.local`
    const { data: alvo } = await supabase.from('usuarios').insert({ nome: 'Alvo2', email, role: 'vendedor', ativo: true, senha_hash: 'x' }).select('id').single()
    criados.push(alvo.id)

    const r = await chamar('PATCH', `/api/usuarios/${alvo.id}`, { token: tokenAdmin, body: { role: 'super-hacker' } })
    assert.equal(r.status, 400)
    const depois = await buscarUsuario(alvo.id)
    assert.equal(depois.role, 'vendedor')
  })

  await tSuite.test('ACHADO CRÍTICO TESTADO, NÃO ENCONTRADO: vendedor não consegue elevar o PRÓPRIO papel — bloqueado por adminOnly antes de qualquer checagem de role', async () => {
    const antes = await buscarUsuario(idVendedorA)
    assert.equal(antes.role, 'vendedor')

    const r = await chamar('PATCH', `/api/usuarios/${idVendedorA}`, { token: tokenVendedorA, body: { role: 'admin' } })
    assert.equal(r.status, 403, 'vendedor não pode chamar PATCH /api/usuarios nem no próprio id')

    const depois = await buscarUsuario(idVendedorA)
    assert.equal(depois.role, 'vendedor', 'papel do vendedor precisa continuar exatamente igual')
  })

  await tSuite.test('PATCH /api/auth/senha (autoatendimento): mesmo enviando "role" no corpo de propósito, o papel nunca muda', async () => {
    // Histórico (até 2026-09-12): src/routes/auth.js montava '/senha' SEM o
    // middleware `auth` (nem inline, nem via app.use('/api/auth', authRouter)
    // em src/index.js — comentário "Login — sem autenticação" cobria o
    // router inteiro; só '/me' aplicava `auth` inline). Na prática, toda
    // chamada real a esta rota quebrava com "Cannot read properties of
    // undefined (reading 'id')" antes mesmo de checar `senha_atual` —
    // ninguém, nem com token válido, completava a troca. Corrigido em
    // 2026-09-12 (`router.patch('/senha', auth, ...)`); cobertura adversarial
    // dedicada em scripts/tests/collection/auth-senha-middleware-ausente-20260912.test.mjs.
    // Este teste aqui, mesmo antes da correção, já bastava pra responder a
    // pergunta desta tarefa (controle de acesso financeiro): não existe
    // caminho de auto-elevação por aqui, nem em teoria — o destructure em
    // auth.js é só `{ senha_atual, nova_senha }`, `role` nunca é lido.
    const senhaAtualHash = await (await import('bcryptjs')).default.hash('senha-original', 10)
    await supabase.from('usuarios').update({ senha_hash: senhaAtualHash }).eq('id', idVendedorA)

    await chamar('PATCH', '/api/auth/senha', {
      token: tokenVendedorA,
      body: { senha_atual: 'senha-original', nova_senha: 'senha-nova-123', role: 'admin' }, // role enviado de propósito
    })
    // Não afirmamos o status aqui (não é o foco deste arquivo) — só que, seja
    // qual for o resultado, o papel nunca muda.
    const depois = await buscarUsuario(idVendedorA)
    assert.equal(depois.role, 'vendedor', 'papel não pode mudar por esta rota em nenhuma circunstância')
  })
})
