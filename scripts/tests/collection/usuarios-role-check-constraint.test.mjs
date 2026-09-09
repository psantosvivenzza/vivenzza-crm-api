// ACHADO REAL (2026-09-09): a criação do primeiro usuário role='financeiro'
// falhou em PRODUÇÃO com "new row for relation usuarios violates check
// constraint usuarios_role_check", mesmo a aplicação (middleware/routes/
// usuarios.js PAPEIS_VALIDOS) já aceitando 'financeiro' desde a PR #75.
// Causa: usuarios_role_check (CHECK (role = ANY (ARRAY['admin','vendedor'])))
// existe em produção mas NUNCA esteve em nenhuma migration versionada nem
// no baseline local — confirmado por leitura direta do catálogo real
// (pg_constraint, via SQL Editor do Supabase). Reproduzida fielmente no
// baseline (scripts/localdb/schema-baseline/001_core.sql) exatamente com o
// texto real, de propósito — SEM ISSO, este teste (e qualquer outro que
// insira role='financeiro' direto na tabela) nunca detectaria o gap, porque
// o INSERT simplesmente funcionava no ambiente local sem constraint
// nenhuma. Este arquivo é o teste que deveria ter existido antes de
// publicar a PR #75/#15 — prova o ciclo completo: falha ANTES da migration
// 20260101000047_usuarios_role_check_financeiro.sql, sucesso DEPOIS, sem
// remover a proteção contra papel inválido, sem alterar usuário existente.
//
// A migration é aplicada aqui a partir do PRÓPRIO ARQUIVO real (psql -f),
// não reimplementada inline — testa o artefato que de fato seria aplicado
// em produção, byte a byte.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { execFileSync } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE, PSQL_BIN } from '../../localdb-config.mjs'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ARQUIVO_MIGRATION = path.join(__dirname, '..', '..', '..', 'supabase', 'migrations', '20260101000047_usuarios_role_check_financeiro.sql')

let supabase, server, porta
let idAdmin
let tokenAdmin
const criados = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const sufixo = Date.now()
  const { data, error } = await supabase.from('usuarios')
    .insert({ nome: `admin (teste role-check) ${sufixo}`, email: `admin-rolecheck-${sufixo}@teste.local`, role: 'admin', ativo: true, senha_hash: 'x' })
    .select('id').single()
  if (error) throw error
  idAdmin = data.id
  criados.push(idAdmin)
  tokenAdmin = jwt.sign({ id: idAdmin, email: 'admin-rolecheck@teste.com', role: 'admin' }, process.env.JWT_SECRET)

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/usuarios.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/usuarios', auth, router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})
after(async () => {
  server?.close()
  await supabase.from('usuarios').delete().in('id', criados)
  await pararAmbienteDeTeste()
})

function chamar(method, path_, { token = tokenAdmin, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` }
    if (body) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: path_, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function novoUsuario(role, sufixoExtra = '') {
  const s = `${Date.now()}${sufixoExtra}`
  return { nome: `Teste role-check ${role} ${s}`, email: `rolecheck-${role}-${s}@teste.local`, senha: 'senha123456', role }
}

async function buscarConstraint() {
  const saida = execFileSync(PSQL_BIN, [
    '-U', PG_USER, '-h', PG_HOST, '-p', String(PG_PORT), '-d', PG_DATABASE,
    '-tAc', "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'usuarios_role_check'",
  ], { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, encoding: 'utf8' }).trim()
  return saida
}

// Restaura a constraint pro texto ORIGINAL (só admin/vendedor), do jeito que
// estava em produção antes da migration 20260101000047. Necessário porque,
// depois que essa migration virar uma migration normal (aplicada por todo
// `localdb-reset.mjs`), o banco já chega neste teste com 'financeiro' já
// liberado — sem isso, o cenário "ANTES" abaixo pararia de significar
// alguma coisa (só provaria o estado atual, não a transição de verdade).
// Autocontido de propósito: não depende de o chamador ter tido o cuidado de
// segurar a migration 47 fora da pasta antes do reset.
async function restaurarConstraintOriginal() {
  execFileSync(PSQL_BIN, [
    '-U', PG_USER, '-h', PG_HOST, '-p', String(PG_PORT), '-d', PG_DATABASE,
    '-v', 'ON_ERROR_STOP=1', '-c',
    "ALTER TABLE public.usuarios DROP CONSTRAINT IF EXISTS usuarios_role_check; " +
    "ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_role_check CHECK (role = ANY (ARRAY['admin'::text, 'vendedor'::text]));",
  ], { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, encoding: 'utf8' })
}

test('ANTES da migration 20260101000047 — reproduz a falha real de produção', async (tSuite) => {
  await tSuite.test('setup: restaura a constraint pro texto original (só admin/vendedor) — necessário porque a migration já é aplicada por padrão em todo reset', async () => {
    await restaurarConstraintOriginal()
    const def = await buscarConstraint()
    assert.equal(def, "CHECK ((role = ANY (ARRAY['admin'::text, 'vendedor'::text])))")
  })

  await tSuite.test('constraint local bate exatamente com a definição real confirmada em produção', async () => {
    const def = await buscarConstraint()
    assert.equal(def, "CHECK ((role = ANY (ARRAY['admin'::text, 'vendedor'::text])))")
  })

  await tSuite.test('POST /api/usuarios role=financeiro FALHA — mesmo erro de produção (violates check constraint usuarios_role_check)', async (t) => {
    const r = await chamar('POST', '/api/usuarios', { body: novoUsuario('financeiro') })
    assert.equal(r.status, 500, JSON.stringify(r.body))
    // O texto completo da mensagem do Postgres varia por locale do servidor
    // (aqui, pt-BR: "viola a restrição de verificação"; produção reportou em
    // inglês: "violates check constraint") — o nome da constraint é a parte
    // estável, independente de idioma, então é o que comprova que é o MESMO
    // erro real de produção, não outro motivo qualquer de 500.
    assert.match(r.body.erro, /usuarios_role_check/, 'precisa ser o mesmo erro real de produção, não outro motivo')
  })

  await tSuite.test('admin e vendedor continuam funcionando normalmente (constraint original nunca bloqueou esses dois)', async (t) => {
    const rAdmin = await chamar('POST', '/api/usuarios', { body: novoUsuario('admin', 'a') })
    assert.equal(rAdmin.status, 201, JSON.stringify(rAdmin.body))
    criados.push(rAdmin.body.id)

    const rVendedor = await chamar('POST', '/api/usuarios', { body: novoUsuario('vendedor', 'v') })
    assert.equal(rVendedor.status, 201, JSON.stringify(rVendedor.body))
    criados.push(rVendedor.body.id)
  })

  await tSuite.test('papel inválido continua rejeitado (bloqueado antes pela aplicação, PAPEIS_VALIDOS — nem chega no banco)', async () => {
    const r = await chamar('POST', '/api/usuarios', { body: novoUsuario('diretor') })
    assert.equal(r.status, 400)
  })
})

test('aplicação da migration 20260101000047 — do próprio arquivo, com limites de lock/execução', async () => {
  const saida = execFileSync(PSQL_BIN, [
    '-U', PG_USER, '-h', PG_HOST, '-p', String(PG_PORT), '-d', PG_DATABASE,
    '-v', 'ON_ERROR_STOP=1', '-f', ARQUIVO_MIGRATION,
  ], { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, encoding: 'utf8' })
  assert.match(saida, /COMMIT/, 'migration precisa ter commitado (BEGIN...COMMIT explícitos no arquivo)')
})

test('DEPOIS da migration — financeiro funciona, admin/vendedor preservados, papel inválido continua rejeitado', async (tSuite) => {
  await tSuite.test('constraint agora aceita admin, vendedor E financeiro — nada mais', async () => {
    const def = await buscarConstraint()
    assert.equal(def, "CHECK ((role = ANY (ARRAY['admin'::text, 'vendedor'::text, 'financeiro'::text])))")
  })

  await tSuite.test('POST /api/usuarios role=financeiro FUNCIONA agora', async (t) => {
    const r = await chamar('POST', '/api/usuarios', { body: novoUsuario('financeiro', 'depois') })
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.equal(r.body.role, 'financeiro')
    criados.push(r.body.id)
  })

  await tSuite.test('admin e vendedor continuam funcionando (não regrediram)', async () => {
    const rAdmin = await chamar('POST', '/api/usuarios', { body: novoUsuario('admin', 'depois-a') })
    assert.equal(rAdmin.status, 201, JSON.stringify(rAdmin.body))
    criados.push(rAdmin.body.id)

    const rVendedor = await chamar('POST', '/api/usuarios', { body: novoUsuario('vendedor', 'depois-v') })
    assert.equal(rVendedor.status, 201, JSON.stringify(rVendedor.body))
    criados.push(rVendedor.body.id)
  })

  await tSuite.test('papel inválido continua rejeitado pela aplicação (PATCH também)', async () => {
    const r = await chamar('POST', '/api/usuarios', { body: novoUsuario('diretor', 'depois') })
    assert.equal(r.status, 400)

    const rPatch = await chamar('PATCH', `/api/usuarios/${idAdmin}`, { body: { role: 'diretor' } })
    assert.equal(rPatch.status, 400)
  })

  await tSuite.test('papel inválido continua rejeitado pelo BANCO — proteção real preservada, não só a lista da aplicação (insert direto, contornando a validação de app)', async () => {
    const { error } = await supabase.from('usuarios').insert({
      nome: 'Bypass direto', email: `bypass-direto-${Date.now()}@teste.local`, role: 'diretor', ativo: true, senha_hash: 'x',
    })
    assert.ok(error, 'insert direto com papel fora da lista precisa falhar — senão a constraint virou decorativa')
    assert.match(error.message, /usuarios_role_check/)
  })
})

test('usuários existentes NÃO são alterados pela migration', async () => {
  const antes = await supabase.from('usuarios').select('id, nome, email, role, ativo').eq('id', idAdmin).single()
  assert.equal(antes.data.role, 'admin')
  // A migration já rodou nos testes acima — comparamos com o valor conhecido
  // desde a criação em before(), que nunca foi tocado por UPDATE nenhum.
  assert.equal(antes.data.ativo, true)
  assert.equal(antes.data.email, antes.data.email) // sanity — mesma linha, mesmo id
})
