// Cobre: GET /api/ponto-admin/prontidao — checagem operacional agregada
// (tabelas do módulo, bucket de fotos, trava de marcação direta, piloto,
// contagens). Motivado por uma auditoria (2026-09-24) que precisou
// reconstruir manualmente essas respostas via arqueologia em código,
// histórico de commits e produção, por falta de um jeito direto de
// perguntar.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  subirServidorDeTeste, pararServidorDeTeste, obterSupabaseDeTeste,
  gerarToken, chamar, criarUsuarioDeTeste,
} from './_setup.mjs'
import { TABELAS_MEU_PONTO } from '../../../src/lib/ponto/prontidao.js'

let admin, colaborador
const criados = []

before(async () => {
  await subirServidorDeTeste()
  admin = await criarUsuarioDeTeste({ role: 'admin' })
  colaborador = await criarUsuarioDeTeste({ role: 'vendedor' })
  criados.push(admin.id, colaborador.id)
})

after(async () => {
  const supabase = obterSupabaseDeTeste()
  await supabase.from('ponto_habilitacoes').delete().in('usuario_id', criados)
  await supabase.from('usuarios').delete().in('id', criados)
  await pararServidorDeTeste()
})

test('prontidão reporta as 12 tabelas do módulo presentes no cluster isolado de teste', async () => {
  const { status, body } = await chamar('GET', '/api/ponto-admin/prontidao', { token: gerarToken(admin) })
  assert.equal(status, 200)
  assert.equal(body.tabelas.esperadas, TABELAS_MEU_PONTO.length)
  assert.equal(body.tabelas.presentes, TABELAS_MEU_PONTO.length)
  assert.deepEqual(body.tabelas.ausentes, [])
})

test('prontidão confirma a trava estrutural de marcação direta, mesmo em teste', async () => {
  const { body } = await chamar('GET', '/api/ponto-admin/prontidao', { token: gerarToken(admin) })
  assert.equal(body.marcacao_direta_bloqueada_por_codigo, true, 'nunca deve reportar destravado — isso é a constante de código, não config')
})

test('prontidão reporta config do piloto disponível e legível', async () => {
  const { body } = await chamar('GET', '/api/ponto-admin/prontidao', { token: gerarToken(admin) })
  assert.equal(body.piloto_config_disponivel, true)
  assert.equal(typeof body.piloto_ativo, 'boolean')
})

test('prontidão reporta bucket de fotos como não-verificável em modo local (compat client não tem .storage)', async () => {
  const { body } = await chamar('GET', '/api/ponto-admin/prontidao', { token: gerarToken(admin) })
  assert.equal(body.bucket_fotos.verificavel, false)
  assert.equal(body.bucket_fotos.existe, null)
  assert.equal(body.bucket_fotos.motivo, 'modo_local_sem_storage_real')
})

test('total_habilitados reflete o estado real do banco, não um valor fixo', async () => {
  const antes = await chamar('GET', '/api/ponto-admin/prontidao', { token: gerarToken(admin) })
  const { error } = await obterSupabaseDeTeste().from('ponto_habilitacoes').insert({ usuario_id: colaborador.id, habilitado: true })
  assert.equal(error, null)
  const depois = await chamar('GET', '/api/ponto-admin/prontidao', { token: gerarToken(admin) })
  assert.equal(depois.body.total_habilitados, antes.body.total_habilitados + 1)
})
