// CORREÇÃO 2026-08-27 — auditoria de prioridade de telefones achou que
// telefoneDoCliente() (src/jobs/sync-financeiro-legado.js) escolhia o 1º
// contato do array cujo tipo estivesse em [celular, fone, telefone, contato],
// sem prioridade real por tipo — a ORDEM do array do NetVision decidia, não
// o tipo. Este arquivo prova a nova regra determinística (celular > fone/
// telefone > contato genérico, primeira ocorrência preservada dentro do
// mesmo grupo) contra código real, sem rede/banco — função pura.
import { test } from 'node:test'
import assert from 'node:assert/strict'
// telefoneDoCliente() em si não toca banco, mas sync-financeiro-legado.js
// importa supabase-admin.server.js no topo do arquivo, que valida
// LOCAL_PG_URL (ou SUPABASE_URL/KEY) de forma EAGER no momento do import —
// mesmo padrão de setup de todo teste de collection (ver _setup.mjs), só
// que sem precisar do Fake Evolution (este arquivo nunca chama a Evolution).
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

const { telefoneDoCliente } = await import('../../../src/jobs/sync-financeiro-legado.js')

test('telefoneDoCliente: prioridade celular > fone/telefone > contato', async (t) => {
  await t.test('1. celular antes de fixo no array -> celular', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'celular', valor: '51999990001' }, { tipo: 'fone', valor: '5132220002' }] })
    assert.equal(r, '51999990001')
  })

  await t.test('2. fixo antes de celular no array -> celular (prioridade vence a ordem)', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'fone', valor: '5132220002' }, { tipo: 'celular', valor: '51999990001' }] })
    assert.equal(r, '51999990001')
  })

  await t.test('3. telefone (variante de fixo) antes de celular -> celular', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'telefone', valor: '5132220002' }, { tipo: 'celular', valor: '51999990001' }] })
    assert.equal(r, '51999990001')
  })

  await t.test('4. contato genérico antes de celular -> celular', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'contato', valor: '51999990003' }, { tipo: 'celular', valor: '51999990001' }] })
    assert.equal(r, '51999990001')
  })

  await t.test('5. dois celulares -> primeiro celular do array (ordem original preservada dentro do grupo)', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'celular', valor: '51999990001' }, { tipo: 'celular', valor: '51999990009' }] })
    assert.equal(r, '51999990001')
  })

  await t.test('6. celular vazio + fixo válido -> fixo (celular sem valor utilizável não conta)', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'celular', valor: '' }, { tipo: 'fone', valor: '5132220002' }] })
    assert.equal(r, '5132220002')
  })

  await t.test('7. celular inválido/sem valor + telefone válido -> telefone', () => {
    const r1 = telefoneDoCliente({ contatos: [{ tipo: 'celular', valor: null }, { tipo: 'telefone', valor: '5132220002' }] })
    assert.equal(r1, '5132220002')
    const r2 = telefoneDoCliente({ contatos: [{ tipo: 'celular' }, { tipo: 'telefone', valor: '5132220002' }] })
    assert.equal(r2, '5132220002')
  })

  await t.test('8. só contato genérico -> contato', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'contato', valor: '51999990003' }] })
    assert.equal(r, '51999990003')
  })

  await t.test('9. nenhum contato válido -> null', () => {
    assert.equal(telefoneDoCliente({ contatos: [] }), null)
    assert.equal(telefoneDoCliente({ contatos: [{ tipo: 'email', valor: 'a@b.com' }] }), null)
    assert.equal(telefoneDoCliente({ contatos: [{ tipo: 'celular', valor: '' }, { tipo: 'fone', valor: '  ' }] }), null)
    assert.equal(telefoneDoCliente({ contatos: null }), null)
    assert.equal(telefoneDoCliente({}), null)
    assert.equal(telefoneDoCliente(null), null)
  })

  await t.test('10. mesmo número em celular e fixo -> resultado estável (escolhe celular, valor final pode ser igual ao antigo)', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'fone', valor: '51999990001' }, { tipo: 'celular', valor: '51999990001' }] })
    assert.equal(r, '51999990001')
  })

  await t.test('11. tipo com maiúsculas/espaços -> prioridade correta (case-insensitive + trim)', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: '  Fone  ', valor: '5132220002' }, { tipo: 'CELULAR', valor: '51999990001' }] })
    assert.equal(r, '51999990001')
  })

  await t.test('12. ordem dentro da mesma categoria preservada (2 fones, sem celular)', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'fone', valor: '5132220002' }, { tipo: 'telefone', valor: '5132220009' }] })
    assert.equal(r, '5132220002', 'primeiro contato de fixo do array, entre fone e telefone (mesmo grupo de prioridade)')
  })

  await t.test('regressão: comportamento antigo preservado quando só existe 1 tipo de contato (sem celular no cadastro)', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'fone', valor: '5132220002' }] })
    assert.equal(r, '5132220002')
  })

  await t.test('não concatena múltiplos contatos válidos — sempre retorna 1 único valor', () => {
    const r = telefoneDoCliente({ contatos: [{ tipo: 'celular', valor: '51999990001' }, { tipo: 'celular', valor: '51999990009' }, { tipo: 'fone', valor: '5132220002' }] })
    assert.equal(typeof r, 'string')
    assert.equal(r, '51999990001')
  })
})
