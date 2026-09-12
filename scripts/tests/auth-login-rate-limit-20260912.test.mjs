// Auditoria adversarial de 2026-09-12 (abuso/rate limiting/reautenticação,
// iniciada no contexto da pilha "Meu Ponto") — achado relacionado, fora do
// módulo Meu Ponto: POST /api/auth/login não tinha NENHUM limite de taxa,
// diferente de /api/public/leads e /api/public/alerta-whatsapp (as outras
// rotas públicas de src/index.js, ambas com rateLimit próprio desde a
// criação). Permitia força bruta de senha sem throttle contra qualquer
// conta do sistema — inclusive gestor/admin.
//
// Postgres exclusivo desta suíte (nunca 5432/5433/vivenzza_dev, nunca
// produção): porta/banco definidos via LOCAL_PG_PORT/LOCAL_PG_DATABASE no
// ambiente antes de rodar (ver scripts/localdb-start.mjs/localdb-reset.mjs).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import bcrypt from 'bcryptjs'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-auth-login-nao-e-producao'

let servidor, porta, supabase
const criados = []

before(async () => {
  const expressModule = await import('express')
  const express = expressModule.default
  const authRouter = (await import('../../src/routes/auth.js')).default
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))

  const app = express()
  app.use(express.json())
  // Mesmo mount de src/index.js — /api/auth sem middleware `auth` no
  // app.use (login precisa ser público); só GET /me exige auth por rota.
  app.use('/api/auth', authRouter)

  servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  porta = servidor.address().port
})

after(async () => {
  await supabase.from('usuarios').delete().in('id', criados)
  await new Promise((resolve) => servidor.close(resolve))
})

function chamar(method, caminho, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port: porta, method,
      path: caminho,
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

let contador = 0
async function novoUsuario(senha = 'senhaRealDoUsuario123') {
  contador += 1
  const sufixo = `${Date.now()}-${contador}`
  const senha_hash = await bcrypt.hash(senha, 4) // custo baixo — só em teste
  const { data, error } = await supabase
    .from('usuarios')
    .insert({
      nome: `Usuário Teste Login ${sufixo}`,
      email: `login-teste-${sufixo}@example.invalid`,
      role: 'vendedor',
      ativo: true,
      senha_hash,
    })
    .select('id, email')
    .single()
  if (error) throw error
  criados.push(data.id)
  return { ...data, senha }
}

// Roda ANTES dos testes que esgotam o limite de propósito — todos os
// testes deste arquivo compartilham o mesmo processo `node --test` e,
// portanto, o mesmo contador em memória do limitador (chave por IP, e
// todas as chamadas daqui saem de 127.0.0.1). Depois que os testes de
// abuso abaixo esgotam o orçamento de 10/15min, um login legítimo dentro
// desta mesma execução também seria 429 — o que é o comportamento
// CORRETO do limitador (ele não sabe distinguir teste de ataque), não um
// bug; só precisa rodar primeiro para provar o caminho feliz isolado.
test('controle positivo: login com a senha real funciona quando dentro do limite', async () => {
  const usuario = await novoUsuario('senhaCorretaDeVerdade!')
  const resposta = await chamar('POST', '/api/auth/login', { email: usuario.email, senha: usuario.senha })
  assert.equal(resposta.status, 200)
  assert.ok(resposta.body.token, 'login válido deveria retornar um token')
})

test('força bruta de senha: mais de 10 tentativas de login em 15 minutos são bloqueadas (429)', async () => {
  const usuario = await novoUsuario()
  const respostas = []
  for (let i = 0; i < 12; i++) {
    respostas.push(await chamar('POST', '/api/auth/login', { email: usuario.email, senha: `senha-errada-${i}` }))
  }
  const bloqueadas = respostas.filter((r) => r.status === 429)
  const naoBloqueadas = respostas.filter((r) => r.status !== 429)
  assert.ok(bloqueadas.length > 0, 'pelo menos uma das 12 tentativas rápidas deveria bater no limite de 10/15min')
  assert.ok(naoBloqueadas.length <= 10, `no máximo 10 tentativas deveriam passar do limitador; passaram ${naoBloqueadas.length}`)
  // Nenhuma das tentativas com senha errada deveria ter autenticado de verdade.
  for (const r of respostas) {
    assert.notEqual(r.status, 200, 'nenhuma tentativa com senha errada deveria retornar 200')
  }
})

test('limite bloqueia por origem, não por conta-alvo: esgotar tentando a conta A também bloqueia tentativas contra a conta B', async () => {
  const usuarioA = await novoUsuario()
  const usuarioB = await novoUsuario()

  for (let i = 0; i < 10; i++) {
    await chamar('POST', '/api/auth/login', { email: usuarioA.email, senha: `tentativa-${i}` })
  }
  const aindaContraA = await chamar('POST', '/api/auth/login', { email: usuarioA.email, senha: 'mais-uma' })
  assert.equal(aindaContraA.status, 429, 'já deveria estar bloqueado contra a conta A depois de 10 tentativas')

  // Um atacante não pode contornar o limite só trocando o e-mail-alvo a
  // partir da mesma origem — o limite é por IP (chave padrão do
  // express-rate-limit), não por conta tentada.
  const agoraContraB = await chamar('POST', '/api/auth/login', { email: usuarioB.email, senha: 'tentativa-em-outra-conta' })
  assert.equal(agoraContraB.status, 429, 'a mesma origem já deveria estar bloqueada mesmo mudando de conta-alvo')
})
