// Cobertura funcional de POST /api/notas-entrada (fn_criar_nota_entrada),
// separada de notas-entrada-controle-acesso.test.mjs (gate de papel Express)
// e notas-entrada-fn-criar-grants.test.mjs (GRANT/REVOKE de banco). Exercita
// a rota real de ponta a ponta contra supabase/migrations/20260101000064-000066
// (versionadas nesta tarefa) + scripts/localdb/schema-baseline/007_notas_entrada_dre.sql
// — fecha o gap descrito no topo (histórico) de notas-entrada-controle-acesso.test.mjs:
// até então não havia como testar a execução real da RPC neste ambiente.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta, token
let idUsuario
const produtosCriados = []
const numerosNotaCriados = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const sufixo = Date.now()
  const { data, error } = await supabase.from('usuarios')
    .insert({ nome: 'usuario (teste nef)', email: `nef-${sufixo}@teste-nef.local`, role: 'admin', ativo: true })
    .select('id').single()
  if (error) throw error
  idUsuario = data.id
  token = jwt.sign({ id: idUsuario, email: 'nef@teste.com', role: 'admin' }, process.env.JWT_SECRET)

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/notas-entrada.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/notas-entrada', auth, router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port
})

after(async () => {
  server?.close()
  if (numerosNotaCriados.length) {
    await supabase.from('movimentacoes_estoque').delete().in('documento_ref', numerosNotaCriados)
    const { data: notas } = await supabase.from('notas_entrada').select('id, conta_financeira_id').in('numero_nota', numerosNotaCriados)
    const idsNota = (notas || []).map((n) => n.id)
    const idsConta = (notas || []).map((n) => n.conta_financeira_id).filter(Boolean)
    if (idsNota.length) await supabase.from('notas_entrada_itens').delete().in('nota_entrada_id', idsNota)
    await supabase.from('notas_entrada').delete().in('numero_nota', numerosNotaCriados)
    if (idsConta.length) await supabase.from('contas_financeiras').delete().in('id', idsConta)
  }
  if (produtosCriados.length) {
    await supabase.from('estoque').delete().in('produto_id', produtosCriados)
    await supabase.from('produtos').delete().in('id', produtosCriados)
  }
  await supabase.from('usuarios').delete().eq('id', idUsuario)
  await pararAmbienteDeTeste()
})

async function criarProduto(nome, precoCustoInicial = null) {
  const { data, error } = await supabase.from('produtos').insert({ nome, preco_custo: precoCustoInicial }).select('id').single()
  if (error) throw error
  produtosCriados.push(data.id)
  return data.id
}

function post(body) {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body)
    const req = http.request({
      host: '127.0.0.1', port: porta, method: 'POST', path: '/api/notas-entrada',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.write(json)
    req.end()
  })
}

async function saldoEstoque(produtoId) {
  const { data } = await supabase.from('estoque').select('quantidade').eq('produto_id', produtoId).maybeSingle()
  return data ? Number(data.quantidade) : null
}

async function custoProduto(produtoId) {
  const { data } = await supabase.from('produtos').select('preco_custo').eq('id', produtoId).single()
  return data.preco_custo === null ? null : Number(data.preco_custo)
}

test('POST /api/notas-entrada — cria nota + itens + movimentação de estoque, sem conta a pagar', async () => {
  const produtoId = await criarProduto('TESTE FLUXO NEA - Produto A')
  const numeroNota = `NEF-CRIACAO-${Date.now()}`
  const r = await post({
    numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-10',
    valor_total: 100, forma_pagamento: 'boleto', gerar_conta_pagar: false,
    itens: [{ produto_id: produtoId, quantidade: 10, valor_unitario: 10, atualizar_custo: false }],
  })
  numerosNotaCriados.push(numeroNota)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(r.body.status, 'confirmada', 'fn_criar_nota_entrada nunca seta status — sempre fica no default do banco')
  assert.equal(r.body.conta_financeira_id, null)

  const { data: itens } = await supabase.from('notas_entrada_itens').select('*').eq('nota_entrada_id', r.body.id)
  assert.equal(itens.length, 1)
  assert.equal(Number(itens[0].valor_total), 100)

  const { data: movs } = await supabase.from('movimentacoes_estoque').select('*').eq('documento_ref', numeroNota)
  assert.equal(movs.length, 1)
  assert.equal(movs[0].tipo, 'entrada')
  assert.equal(Number(movs[0].quantidade), 10)

  assert.equal(await saldoEstoque(produtoId), 10, 'trg_atualizar_saldo precisa refletir a movimentação em estoque.quantidade')
})

test('POST /api/notas-entrada — múltiplos itens do mesmo produto acumulam saldo em estoque corretamente', async () => {
  const produtoId = await criarProduto('TESTE FLUXO NEA - Produto Multi Item')
  const numeroNota = `NEF-MULTIITEM-${Date.now()}`
  const r = await post({
    numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-13',
    valor_total: 130, forma_pagamento: 'boleto', gerar_conta_pagar: false,
    itens: [
      { produto_id: produtoId, quantidade: 3, valor_unitario: 10, atualizar_custo: false },
      { produto_id: produtoId, quantidade: 10, valor_unitario: 10, atualizar_custo: false },
    ],
  })
  numerosNotaCriados.push(numeroNota)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.equal(await saldoEstoque(produtoId), 13)

  const { data: movs } = await supabase.from('movimentacoes_estoque').select('quantidade').eq('documento_ref', numeroNota)
  assert.equal(movs.length, 2, 'uma movimentação de estoque por item, nunca uma só agregada')
})

test('POST /api/notas-entrada — gerar_conta_pagar=true cria contas_financeiras vinculada e exige vencimento', async () => {
  const produtoId = await criarProduto('TESTE FLUXO NEA - Produto Conta')
  const numeroNota = `NEF-CONTA-${Date.now()}`
  const r = await post({
    numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-11',
    valor_total: 255, forma_pagamento: 'boleto', gerar_conta_pagar: true, vencimento: '2026-04-11',
    itens: [{ produto_id: produtoId, quantidade: 10, valor_unitario: 25.5, atualizar_custo: false }],
  })
  numerosNotaCriados.push(numeroNota)
  assert.equal(r.status, 201, JSON.stringify(r.body))
  assert.ok(r.body.conta_financeira_id)

  const { data: conta } = await supabase.from('contas_financeiras').select('*').eq('id', r.body.conta_financeira_id).single()
  assert.equal(conta.tipo, 'pagar')
  assert.equal(Number(conta.valor), 255)
  assert.equal(conta.status, 'aberta')
  assert.equal(conta.categoria_dre, null, 'fn_criar_nota_entrada nunca seta categoria_dre — ver docs/financeiro/decisoes-e-riscos-notas-entrada-dre.md (achado crítico #2, DRE ignora esta conta)')

  const r2 = await post({
    numero_nota: `${numeroNota}-SEM-VENCIMENTO`, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-11',
    valor_total: 10, forma_pagamento: 'boleto', gerar_conta_pagar: true,
    itens: [{ produto_id: produtoId, quantidade: 1, valor_unitario: 10 }],
  })
  assert.equal(r2.status, 400, 'vencimento é obrigatório quando gerar_conta_pagar=true — validado na rota Express antes da RPC')
})

test('POST /api/notas-entrada — atualizar_custo controla se produtos.preco_custo muda', async () => {
  const produtoId = await criarProduto('TESTE FLUXO NEA - Produto Custo', 50)

  const numeroNotaFalse = `NEF-CUSTO-FALSE-${Date.now()}`
  await post({
    numero_nota: numeroNotaFalse, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-14',
    valor_total: 999, forma_pagamento: 'boleto', gerar_conta_pagar: false,
    itens: [{ produto_id: produtoId, quantidade: 1, valor_unitario: 999, atualizar_custo: false }],
  })
  numerosNotaCriados.push(numeroNotaFalse)
  assert.equal(await custoProduto(produtoId), 50, 'atualizar_custo=false precisa preservar o custo anterior')

  const numeroNotaTrue = `NEF-CUSTO-TRUE-${Date.now()}`
  await post({
    numero_nota: numeroNotaTrue, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-15',
    valor_total: 777.77, forma_pagamento: 'boleto', gerar_conta_pagar: false,
    itens: [{ produto_id: produtoId, quantidade: 1, valor_unitario: 777.77, atualizar_custo: true }],
  })
  numerosNotaCriados.push(numeroNotaTrue)
  assert.equal(await custoProduto(produtoId), 777.77, 'atualizar_custo=true precisa atualizar o custo')
})

test('POST /api/notas-entrada — atualizar_custo omitido no corpo HTTP ainda atualiza custo (rota sempre preenche antes da RPC)', async () => {
  // A rota Express mapeia itens.map(i => ({ ..., atualizar_custo: i.atualizar_custo !== false }))
  // ANTES de montar o payload da RPC — "omitido" no corpo HTTP nunca chega
  // omitido na RPC por este caminho (só testável via chamada direta à RPC,
  // fora do escopo deste arquivo).
  const produtoId = await criarProduto('TESTE FLUXO NEA - Produto Custo Omitido', 50)
  const numeroNota = `NEF-CUSTO-OMITIDO-${Date.now()}`
  await post({
    numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-16',
    valor_total: 555.55, forma_pagamento: 'boleto', gerar_conta_pagar: false,
    itens: [{ produto_id: produtoId, quantidade: 1, valor_unitario: 555.55 }],
  })
  numerosNotaCriados.push(numeroNota)
  assert.equal(await custoProduto(produtoId), 555.55)
})

test('POST /api/notas-entrada — item inválido reverte a transação inteira (nota, itens, estoque, custo, conta a pagar)', async () => {
  const produtoId = await criarProduto('TESTE FLUXO NEA - Produto Rollback', 50)
  const produtoInexistente = '99999999-9999-9999-9999-999999999999'
  const numeroNota = `NEF-ROLLBACK-${Date.now()}`

  const r = await post({
    numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-17',
    valor_total: 5000, forma_pagamento: 'boleto', gerar_conta_pagar: true, vencimento: '2026-04-17',
    itens: [
      { produto_id: produtoId, quantidade: 2, valor_unitario: 50, atualizar_custo: true },
      { produto_id: produtoInexistente, quantidade: 1, valor_unitario: 10 },
    ],
  })
  assert.equal(r.status, 500, 'segundo item inválido precisa propagar erro da RPC (sem bloco EXCEPTION WHEN na função)')

  const { data: notaExiste } = await supabase.from('notas_entrada').select('id').eq('numero_nota', numeroNota)
  assert.equal(notaExiste.length, 0, 'nenhuma nota deve sobrar — toda a transação da RPC reverte, inclusive o 1º item válido')
  assert.equal(await custoProduto(produtoId), 50, 'custo do 1º item não pode ter sido atualizado — revertido junto com o resto')
  assert.equal(await saldoEstoque(produtoId), null, 'nenhuma movimentação de estoque do 1º item pode ter sobrado')

  const { data: contaExiste } = await supabase.from('contas_financeiras').select('id').eq('documento_ref', numeroNota)
  assert.equal(contaExiste.length, 0, 'conta a pagar também precisa ser revertida')
})

test('POST /api/notas-entrada — sem idempotência: repetir a mesma requisição cria duas notas (achado documentado, não corrigido)', async () => {
  // fn_criar_nota_entrada não tem nenhuma chave de idempotência/deduplicação
  // (nenhum UNIQUE em numero_nota+serie, nenhuma checagem de duplicata) — ver
  // docs/financeiro/decisoes-e-riscos-notas-entrada-dre.md. Este teste tranca
  // o comportamento ATUAL (para não regredir silenciosamente pra outra coisa
  // sem decisão explícita), não afirma que É o comportamento desejado.
  const produtoId = await criarProduto('TESTE FLUXO NEA - Produto Duplicado')
  const numeroNota = `NEF-DUPLICADA-${Date.now()}`
  const payload = {
    numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Fluxo NEA', data_emissao: '2026-03-20',
    valor_total: 20, forma_pagamento: 'boleto', gerar_conta_pagar: false,
    itens: [{ produto_id: produtoId, quantidade: 2, valor_unitario: 10, atualizar_custo: false }],
  }
  const r1 = await post(payload)
  const r2 = await post(payload)
  numerosNotaCriados.push(numeroNota)
  assert.equal(r1.status, 201)
  assert.equal(r2.status, 201)
  assert.notEqual(r1.body.id, r2.body.id)

  const { data: notas } = await supabase.from('notas_entrada').select('id').eq('numero_nota', numeroNota)
  assert.equal(notas.length, 2, 'sem UNIQUE/checagem de duplicata, numero_nota repetido cria 2 linhas — comportamento real, não corrigido nesta tarefa')
})
