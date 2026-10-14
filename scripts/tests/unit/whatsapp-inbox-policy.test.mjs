import test from 'node:test'
import assert from 'node:assert/strict'
import { inboxListPolicy } from '../../../src/lib/whatsappInboxPolicy.js'
const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
test('vendedora não pode selecionar outra carteira nem sem responsável', () => {
  for (const requested of [b, 'sem_responsavel']) assert.equal(inboxListPolicy({ id: a, role: 'vendedor' }, { responsavel_id: requested }).status, 403)
  assert.equal(inboxListPolicy({ id: a, role: 'vendedor' }, {}).responsible, a)
})
test('master pode selecionar responsável ou sem responsável', () => {
  assert.equal(inboxListPolicy({ id: a, role: 'admin' }, { responsavel_id: b }).responsible, b)
  assert.equal(inboxListPolicy({ role: 'admin' }, { responsavel_id: 'sem_responsavel' }).responsible, 'sem_responsavel')
})
test('ordem de conversa é opt-in; paginação e parâmetros inválidos são recusados', () => {
  assert.equal(inboxListPolicy({ role: 'admin' }, { ordenacao: 'ultima_mensagem', page: '2', limit: '200' }).offset, 200)
  assert.equal(inboxListPolicy({ role: 'admin' }, {}).activityOrder, false)
  for (const q of [{ page: 0 }, { limit: 1001 }, { limit: 'NaN' }, { responsavel_id: 'invalido' }]) assert.equal(inboxListPolicy({ role: 'admin' }, q).status, 400)
})
