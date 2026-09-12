// Auditoria adversarial de autenticação/autorização em PATCH /api/auth/senha
// (2026-09-12) — achado colateral já registrado em
// scripts/tests/collection/usuarios-papel-financeiro.test.mjs (comentário na
// linha ~138) e citado como "fora do escopo" na PR #87
// (fix/auth-login-rate-limit-ausente-20260912). src/routes/auth.js montava
// '/senha' SEM o middleware `auth` (nem inline, nem no mount de
// src/index.js — só '/login' e '/me' tinham tratamento explícito). Toda
// chamada real quebrava com "Cannot read properties of undefined (reading
// 'id')" antes mesmo de checar `senha_atual` — rota completamente inutilizável
// para autoatendimento legítimo, mas sem tomada de sessão de terceiros: sem
// req.user, ninguém (nem quem manda token válido) conseguia completar a
// troca. Corrigido aqui: `router.patch('/senha', auth, ...)`.
//
// Rotas reais, Postgres local, dados sintéticos. Nenhum usuário real tocado.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta
let idUsuarioA, idUsuarioB
let tokenUsuarioA, tokenUsuarioB
const SENHA_ORIGINAL_A = 'senha-original-a-2026'
const SENHA_ORIGINAL_B = 'senha-original-b-2026'
const criados = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const sufixo = Date.now()
  async function criarUsuarioDeTeste(rotulo, senhaPlana) {
    const senha_hash = await bcrypt.hash(senhaPlana, 10)
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste ash)`, email: `${rotulo}-${sufixo}@teste-ash.local`, role: 'vendedor', ativo: true, senha_hash })
      .select('id').single()
    if (error) throw error
    return data.id
  }
  idUsuarioA = await criarUsuarioDeTeste('usuario-a', SENHA_ORIGINAL_A)
  idUsuarioB = await criarUsuarioDeTeste('usuario-b', SENHA_ORIGINAL_B)

  tokenUsuarioA = jwt.sign({ id: idUsuarioA, email: 'a@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenUsuarioB = jwt.sign({ id: idUsuarioB, email: 'b@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)

  const express = (await import('express')).default
  const authRouter = (await import('../../../src/routes/auth.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/auth', authRouter)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})
after(async () => {
  server?.close()
  await supabase.from('usuarios').delete().in('id', [idUsuarioA, idUsuarioB, ...criados])
  await pararAmbienteDeTeste()
})

function chamar(method, path, { token, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token !== undefined) headers.authorization = `Bearer ${token}`
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

async function buscarHash(id) {
  const { data, error } = await supabase.from('usuarios').select('senha_hash').eq('id', id).single()
  if (error) throw error
  return data.senha_hash
}

test('PATCH /api/auth/senha exige middleware auth (regressão do achado 2026-09-12)', async (tSuite) => {
  await tSuite.test('sem Authorization nenhum: 401, sem 500 de req.user indefinido, senha não muda', async () => {
    const hashAntes = await buscarHash(idUsuarioA)

    const r = await chamar('PATCH', '/api/auth/senha', {
      token: undefined,
      body: { senha_atual: SENHA_ORIGINAL_A, nova_senha: 'tentativa-sem-token-123' },
    })
    assert.equal(r.status, 401, 'sem token, a rota precisa recusar antes de tocar em req.user')
    assert.notEqual(r.status, 500, 'nunca pode vazar TypeError de req.user indefinido')

    const hashDepois = await buscarHash(idUsuarioA)
    assert.equal(hashDepois, hashAntes, 'sem autenticação, o hash de senha não pode mudar')
  })

  await tSuite.test('token malformado/inválido: 401, senha não muda', async () => {
    const hashAntes = await buscarHash(idUsuarioA)

    const r = await chamar('PATCH', '/api/auth/senha', {
      token: 'isto-nao-e-um-jwt-valido',
      body: { senha_atual: SENHA_ORIGINAL_A, nova_senha: 'tentativa-token-invalido-123' },
    })
    assert.equal(r.status, 401)

    const hashDepois = await buscarHash(idUsuarioA)
    assert.equal(hashDepois, hashAntes)
  })

  await tSuite.test('token válido de A + senha_atual errada: 401, senha de A não muda', async () => {
    const hashAntes = await buscarHash(idUsuarioA)

    const r = await chamar('PATCH', '/api/auth/senha', {
      token: tokenUsuarioA,
      body: { senha_atual: 'senha-errada-de-proposito', nova_senha: 'nova-senha-A-999' },
    })
    assert.equal(r.status, 401)
    assert.equal(r.body.erro, 'Senha atual incorreta')

    const hashDepois = await buscarHash(idUsuarioA)
    assert.equal(hashDepois, hashAntes)
  })

  await tSuite.test('token válido de A + senha_atual correta: 200, só o hash de A muda (nunca o de B)', async () => {
    const hashBAntes = await buscarHash(idUsuarioB)
    const novaSenhaA = 'nova-senha-A-legitima-777'

    const r = await chamar('PATCH', '/api/auth/senha', {
      token: tokenUsuarioA,
      body: { senha_atual: SENHA_ORIGINAL_A, nova_senha: novaSenhaA },
    })
    assert.equal(r.status, 200)
    assert.equal(r.body.mensagem, 'Senha atualizada com sucesso')

    const hashANovo = await buscarHash(idUsuarioA)
    assert.ok(await bcrypt.compare(novaSenhaA, hashANovo), 'a nova senha precisa validar contra o hash gravado')
    assert.ok(!(await bcrypt.compare(SENHA_ORIGINAL_A, hashANovo)), 'a senha antiga de A não pode mais validar')

    const hashBDepois = await buscarHash(idUsuarioB)
    assert.equal(hashBDepois, hashBAntes, 'trocar a senha de A nunca pode afetar o hash de B (isolamento por req.user.id)')
  })

  await tSuite.test('token válido de B tentando reaproveitar a senha_atual de A: 401, senha de B não muda (sem vazamento entre contas)', async () => {
    const hashBAntes = await buscarHash(idUsuarioB)

    const r = await chamar('PATCH', '/api/auth/senha', {
      token: tokenUsuarioB,
      body: { senha_atual: SENHA_ORIGINAL_A, nova_senha: 'nova-senha-B-indevida' },
    })
    assert.equal(r.status, 401, 'a senha_atual de A não pode validar a troca da conta de B')

    const hashBDepois = await buscarHash(idUsuarioB)
    assert.equal(hashBDepois, hashBAntes)
  })

  await tSuite.test('campo "role" no corpo é ignorado mesmo com troca de senha bem-sucedida (sem auto-elevação)', async () => {
    const { data: antes } = await supabase.from('usuarios').select('role').eq('id', idUsuarioB).single()
    assert.equal(antes.role, 'vendedor')

    const r = await chamar('PATCH', '/api/auth/senha', {
      token: tokenUsuarioB,
      body: { senha_atual: SENHA_ORIGINAL_B, nova_senha: 'nova-senha-B-legitima-456', role: 'admin' },
    })
    assert.equal(r.status, 200)

    const { data: depois } = await supabase.from('usuarios').select('role').eq('id', idUsuarioB).single()
    assert.equal(depois.role, 'vendedor', 'role nunca muda por esta rota, mesmo enviado de propósito no corpo')
  })
})
