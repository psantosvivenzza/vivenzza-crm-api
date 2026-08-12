// FASE C.3A.1-INFRA (homologação, 2026-08-12) — prova estrutural de que
// supabase-admin.server.js NUNCA cai silenciosamente pro Supabase real em
// NODE_ENV=test, mesmo com credenciais reais/plausíveis presentes no
// ambiente. Cada cenário reimporta o módulo com um query-string único
// (cache-busting do loader ESM) pra reexecutar a lógica de topo-de-arquivo
// do zero — nenhum cenário aqui faz uma chamada de rede real: createClient()
// do supabase-js não conecta na construção, e pg.Pool() não conecta até a
// primeira query.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MODULE_PATH = path.join(__dirname, '..', '..', '..', 'src', 'lib', 'supabase-admin.server.js').replace(/\\/g, '/')

function importFresh() {
  return import(`file:///${MODULE_PATH}?bust=${Date.now()}-${Math.random()}`)
}

const ENV_KEYS = ['NODE_ENV', 'LOCAL_PG_URL', 'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY']

function limparEnvRelevante() {
  for (const k of ENV_KEYS) delete process.env[k]
}

test('supabase-admin.server.js: fail-closed contra Supabase real em NODE_ENV=test', async (t) => {
  const original = {}
  for (const k of ENV_KEYS) original[k] = process.env[k]

  await t.test('1. NODE_ENV=test + LOCAL_PG_URL ausente, mesmo com credenciais Supabase presentes → ABORTA', async () => {
    limparEnvRelevante()
    process.env.NODE_ENV = 'test'
    process.env.SUPABASE_URL = 'https://fake-project-nao-real.supabase.co'
    process.env.SUPABASE_SECRET_KEY = 'fake-nao-e-uma-chave-real-0000000000'

    await assert.rejects(() => importFresh(), /NODE_ENV=test exige LOCAL_PG_URL/)
  })

  await t.test('2. NODE_ENV=test + LOCAL_PG_URL com host NÃO-loopback → ABORTA', async () => {
    limparEnvRelevante()
    process.env.NODE_ENV = 'test'
    process.env.LOCAL_PG_URL = 'postgres://postgres:x@exemplo-remoto-nao-real.supabase.co:5432/postgres'

    await assert.rejects(() => importFresh(), /não é loopback/)
  })

  await t.test('3. NODE_ENV=test + LOCAL_PG_URL malformada (não parseável) → ABORTA', async () => {
    limparEnvRelevante()
    process.env.NODE_ENV = 'test'
    process.env.LOCAL_PG_URL = 'isso não é uma URL'

    await assert.rejects(() => importFresh(), /LOCAL_PG_URL inválida/)
  })

  await t.test('4. NODE_ENV=test + LOCAL_PG_URL loopback válida → usa compat client local, não lança', async () => {
    limparEnvRelevante()
    process.env.NODE_ENV = 'test'
    process.env.LOCAL_PG_URL = 'postgres://postgres:x@127.0.0.1:5433/vivenzza_dev_estrutural'

    const mod = await importFresh()
    assert.ok(mod.supabase)
    assert.equal(typeof mod.supabase.from, 'function', 'compat client local expõe .from()')
  })

  await t.test('5. NODE_ENV != test + LOCAL_PG_URL ausente + sem credenciais Supabase → comportamento de produção preservado (recusa por config incompleta, igual antes)', async () => {
    limparEnvRelevante()
    // NODE_ENV deliberadamente ausente — simula produção real.

    await assert.rejects(() => importFresh(), /Configuração do Supabase incompleta/)
  })

  await t.test('6. NODE_ENV != test + LOCAL_PG_URL ausente + credenciais Supabase presentes → usa Supabase real, sem chamada de rede pra construir o client', async () => {
    limparEnvRelevante()
    process.env.SUPABASE_URL = 'https://fake-project-nao-real.supabase.co'
    process.env.SUPABASE_SECRET_KEY = 'fake-nao-e-uma-chave-real-0000000000'

    const mod = await importFresh()
    assert.ok(mod.supabase)
    assert.equal(typeof mod.supabase.from, 'function', 'client real do supabase-js expõe .from()')
  })

  limparEnvRelevante()
  for (const k of ENV_KEYS) if (original[k] !== undefined) process.env[k] = original[k]
})
