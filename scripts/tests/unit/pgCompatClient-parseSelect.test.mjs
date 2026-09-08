// Teste unitário dedicado da correção do parser de embed do compat client
// local (2026-09-08) — cobre SÓ parseSelect(), função pura, sem Postgres.
// Motivo da correção: src/routes/financeiro.js usa a sintaxe real do
// PostgREST `apelido:tabela!nome_da_fkey(cols)` em GET
// /contas/:contaId/baixas e GET /estornos/pendentes (múltiplos embeds da
// MESMA tabela `usuarios`, cada um via uma FK diferente — precisam de
// apelido pra não colidir). O parser antigo (regex `/(\w+)\(([^)]+)\)/g`)
// só reconhecia `tabela(cols)` simples: o nome da FK (`\w+` imediatamente
// antes do "(") era capturado como se fosse o nome da tabela, e o prefixo
// "apelido:tabela!" sobrava como texto cru na lista de colunas, quebrando a
// query com "erro de sintaxe em ou próximo a ':'". A verificação de que a
// query realmente executa com sucesso contra Postgres real (resolução da
// coluna de FK via introspecção do catálogo) está em
// scripts/tests/collection/pgcompat-embed-fkey-financeiro.test.mjs — este
// arquivo cobre só o parsing em si, isolado.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSelect } from '../../../src/lib/localdev/pgCompatClient.js'

test('parseSelect — "*" sozinho não tem embeds', () => {
  const { main, embeds } = parseSelect('*')
  assert.equal(main, '*')
  assert.deepEqual(embeds, [])
})

test('parseSelect — embed simples sem apelido nem fkey (comportamento pré-existente preservado)', () => {
  const { main, embeds } = parseSelect('*, usuarios(id, nome)')
  assert.equal(main, '*')
  assert.deepEqual(embeds, [{ alias: 'usuarios', tabela: 'usuarios', fkeyName: null, cols: ['id', 'nome'] }])
})

test('parseSelect — embed com apelido e FK nomeada explícita (sintaxe real do PostgREST, achado desta rodada)', () => {
  const { main, embeds } = parseSelect(
    '*, solicitado_por:usuarios!estornos_financeiros_solicitado_por_usuario_id_fkey(id, nome)'
  )
  assert.equal(main, '*')
  assert.deepEqual(embeds, [{
    alias: 'solicitado_por',
    tabela: 'usuarios',
    fkeyName: 'estornos_financeiros_solicitado_por_usuario_id_fkey',
    cols: ['id', 'nome'],
  }])
})

test('parseSelect — embed com FK nomeada mas SEM apelido (alias cai pro nome da tabela)', () => {
  const { embeds } = parseSelect('*, usuarios!estornos_financeiros_solicitado_por_usuario_id_fkey(id, nome)')
  assert.equal(embeds[0].alias, 'usuarios')
  assert.equal(embeds[0].fkeyName, 'estornos_financeiros_solicitado_por_usuario_id_fkey')
})

test('parseSelect — MÚLTIPLOS embeds da MESMA tabela com apelidos diferentes não colidem (o bug que motivou a correção)', () => {
  const { embeds } = parseSelect(`
    *,
    solicitado_por:usuarios!estornos_financeiros_solicitado_por_usuario_id_fkey(id, nome),
    aprovado_por:usuarios!estornos_financeiros_aprovado_por_usuario_id_fkey(id, nome),
    rejeitado_por:usuarios!estornos_financeiros_rejeitado_por_usuario_id_fkey(id, nome)
  `)
  assert.equal(embeds.length, 3)
  assert.deepEqual(embeds.map((e) => e.alias), ['solicitado_por', 'aprovado_por', 'rejeitado_por'])
  assert.deepEqual(embeds.map((e) => e.tabela), ['usuarios', 'usuarios', 'usuarios'])
  assert.deepEqual(embeds.map((e) => e.fkeyName), [
    'estornos_financeiros_solicitado_por_usuario_id_fkey',
    'estornos_financeiros_aprovado_por_usuario_id_fkey',
    'estornos_financeiros_rejeitado_por_usuario_id_fkey',
  ])
})

test('parseSelect — mistura de embeds simples e com apelido+fkey na mesma query (caso real de GET /estornos/pendentes)', () => {
  const { main, embeds } = parseSelect(`
    *,
    baixas_financeiras(id, valor_baixado, data_pagamento, forma_pagamento, origem),
    contas_financeiras(id, pessoa_nome, descricao, documento_ref, valor, valor_pago),
    solicitado_por:usuarios!estornos_financeiros_solicitado_por_usuario_id_fkey(id, nome)
  `)
  assert.equal(main, '*')
  assert.equal(embeds.length, 3)
  assert.deepEqual(embeds[0], { alias: 'baixas_financeiras', tabela: 'baixas_financeiras', fkeyName: null, cols: ['id', 'valor_baixado', 'data_pagamento', 'forma_pagamento', 'origem'] })
  assert.deepEqual(embeds[1], { alias: 'contas_financeiras', tabela: 'contas_financeiras', fkeyName: null, cols: ['id', 'pessoa_nome', 'descricao', 'documento_ref', 'valor', 'valor_pago'] })
  assert.deepEqual(embeds[2], { alias: 'solicitado_por', tabela: 'usuarios', fkeyName: 'estornos_financeiros_solicitado_por_usuario_id_fkey', cols: ['id', 'nome'] })
})

test('parseSelect — colunas normais fora de embed continuam intactas junto com embeds', () => {
  const { main } = parseSelect('id, status, criado_em, criado_por:usuarios!x_fkey(id, nome)')
  assert.equal(main, 'id, status, criado_em')
})
