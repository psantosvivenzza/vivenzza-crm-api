// Cobertura de GET /api/relatorios/dre (calcularSecoesDoMes, src/routes/relatorios.js).
// Fecha o mesmo gap de testabilidade de notas-entrada-fluxo.test.mjs: a rota
// real depende de nfe/nfe_itens/produtos, que agora estão no baseline de
// teste (scripts/localdb/schema-baseline/007_notas_entrada_dre.sql), e do
// suporte a embed com filtro (`nfe!inner(data_emissao,...)`) adicionado a
// src/lib/localdev/pgCompatClient.js nesta tarefa.
//
// "Esperado" de cada seção é calculado à mão aqui, independente da fórmula
// da rota (não é cópia disfarçada de verificação).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta
let tokenAdmin, tokenVendedor
let idUsuario
const produtosCriados = []
const nfeCriadas = []
const contasCriadas = []

function acharSecao(secoes, codigo) {
  return secoes?.find((s) => s.codigo === codigo) || null
}

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const sufixo = Date.now()
  const { data, error } = await supabase.from('usuarios')
    .insert({ nome: 'usuario (teste dre)', email: `dre-${sufixo}@teste-dre.local`, role: 'admin', ativo: true })
    .select('id').single()
  if (error) throw error
  idUsuario = data.id
  tokenAdmin = jwt.sign({ id: idUsuario, email: 'dre-admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)
  tokenVendedor = jwt.sign({ id: idUsuario, email: 'dre-vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/relatorios.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/relatorios', auth, router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port

  // ---- fixtures: produto com custo conhecido + NF-e de um mês só deste arquivo
  // (2031-07, isolado de qualquer outro teste/seed do repositório).
  const { data: produto, error: erroProduto } = await supabase.from('produtos')
    .insert({ nome: `TESTE DRE - Produto A ${sufixo}`, preco_custo: 100 }).select('id').single()
  if (erroProduto) throw erroProduto
  produtosCriados.push(produto.id)
  const produtoId = produto.id

  async function inserirNfe(overrides) {
    const { data: nfe, error: erroNfe } = await supabase.from('nfe').insert({
      serie: 1, status: 'autorizada', tipo_documento: 'nfe_sefaz', data_emissao: '2031-07-01', forma_pagamento: '01',
      valor_produtos: 0, valor_icms: 0, valor_pis: 0, valor_cofins: 0, valor_total: 0,
      ...overrides,
    }).select('id').single()
    if (erroNfe) throw erroNfe
    nfeCriadas.push(nfe.id)
    return nfe.id
  }

  // NFE1 — autorizada, à vista, julho/2031 — entra em receita à vista + custo direto.
  const nfe1 = await inserirNfe({ data_emissao: '2031-07-05', forma_pagamento: '01', valor_produtos: 1000, valor_icms: 100, valor_pis: 10, valor_cofins: 15, valor_total: 1125 })
  await supabase.from('nfe_itens').insert({ nfe_id: nfe1, numero_item: 1, produto_id: produtoId, descricao: 'Produto A', quantidade: 5, valor_unitario: 200, valor_total: 1000 })

  // NFE2 — autorizada, a prazo (forma '02'), julho/2031 — entra em receita a prazo.
  const nfe2 = await inserirNfe({ data_emissao: '2031-07-10', forma_pagamento: '02', valor_produtos: 500, valor_icms: 50, valor_pis: 5, valor_cofins: 7.5, valor_total: 562.5 })
  await supabase.from('nfe_itens').insert({ nfe_id: nfe2, numero_item: 1, produto_id: produtoId, descricao: 'Produto A', quantidade: 2, valor_unitario: 250, valor_total: 500 })

  // NFE3 — cancelada — só entra em Deduções (valor_total), nunca em receita/custo.
  await inserirNfe({ data_emissao: '2031-07-15', status: 'cancelada', forma_pagamento: '01', valor_produtos: 300, valor_icms: 30, valor_pis: 3, valor_cofins: 4.5, valor_total: 300 })

  // NFE4 — série 99 (nota interna) — excluída de tudo (filtro serie===1).
  await inserirNfe({ serie: 99, tipo_documento: 'nota_interna', data_emissao: '2031-07-18', forma_pagamento: '01', valor_produtos: 99999, valor_icms: 9999, valor_pis: 999, valor_cofins: 999, valor_total: 111111 })

  // NFE5 — rascunho — some de todas as seções (nem autorizada nem cancelada).
  await inserirNfe({ data_emissao: '2031-07-20', status: 'rascunho', forma_pagamento: '01', valor_produtos: 777, valor_icms: 77, valor_pis: 7, valor_cofins: 7, valor_total: 777 })

  // NFE6 — agosto/2031 (fora do mês filtrado) — prova exclusão por período.
  await inserirNfe({ data_emissao: '2031-08-01', forma_pagamento: '01', valor_produtos: 2000, valor_icms: 200, valor_pis: 20, valor_cofins: 30, valor_total: 2250 })

  // contas_financeiras — despesas/receitas de julho/2031.
  const contas = [
    { descricao: 'Despesa administrativa teste dre', tipo: 'pagar', categoria_dre: 'administrativa', valor: 200, vencimento: '2031-07-05' },
    { descricao: 'Folha pessoal teste dre', tipo: 'pagar', categoria_dre: 'pessoal', valor: 300, vencimento: '2031-07-10' },
    { descricao: 'Juros bancários teste dre', tipo: 'pagar', categoria_dre: 'financeira', valor: 50, vencimento: '2031-07-12' },
    { descricao: 'Rendimento aplicação teste dre', tipo: 'receber', categoria_dre: 'financeira', valor: 20, vencimento: '2031-07-14' },
    { descricao: 'Retirada sócio teste dre', tipo: 'pagar', categoria_dre: 'retirada', valor: 100, vencimento: '2031-07-16' },
  ]
  for (const c of contas) {
    const { data: conta, error: erroConta } = await supabase.from('contas_financeiras')
      .insert({ ...c, status: 'aberta' }).select('id').single()
    if (erroConta) throw erroConta
    contasCriadas.push(conta.id)
  }
})

after(async () => {
  server?.close()
  if (nfeCriadas.length) {
    await supabase.from('nfe_itens').delete().in('nfe_id', nfeCriadas)
    await supabase.from('nfe').delete().in('id', nfeCriadas)
  }
  if (contasCriadas.length) await supabase.from('contas_financeiras').delete().in('id', contasCriadas)
  if (produtosCriados.length) await supabase.from('produtos').delete().in('id', produtosCriados)
  await supabase.from('usuarios').delete().eq('id', idUsuario)
  await pararAmbienteDeTeste()
})

function getDre(token, qs) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: porta, method: 'GET', path: `/api/relatorios/dre?${qs}`,
      headers: { authorization: `Bearer ${token}` },
    }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('GET /api/relatorios/dre — vendedor é bloqueado (403), admin/financeiro autorizados', async () => {
  const rVendedor = await getDre(tokenVendedor, 'ano=2031&mes=7')
  assert.equal(rVendedor.status, 403)
  const rAdmin = await getDre(tokenAdmin, 'ano=2031&mes=7')
  assert.equal(rAdmin.status, 200)
})

test('GET /api/relatorios/dre — calcula todas as seções A-L corretamente para o mês com dados', async () => {
  const r = await getDre(tokenAdmin, 'ano=2031&mes=7')
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const secoes = r.body.secoes

  const aVista = 1000
  const aPrazo = 500
  const receitaBruta = aVista + aPrazo
  const deducoes = 300
  const impostos = 125 + 62.5
  const receitaLiquida = receitaBruta - deducoes - impostos
  const custoDireto = 5 * 100 + 2 * 100 // preco_custo=100 no momento da consulta
  const lucroBruto = receitaLiquida - custoDireto
  const despesasOperacionais = 200 + 300
  const despesasFinanceiras = 50
  const receitasFinanceiras = 20
  const lucroOperacional = lucroBruto - despesasOperacionais - despesasFinanceiras + receitasFinanceiras
  const retiradas = 100
  const lucroEfetivo = lucroOperacional - retiradas

  assert.equal(Number(acharSecao(secoes, 'A')?.valor), receitaBruta)
  assert.equal(Number(acharSecao(secoes, 'A')?.sublinhas.find((s) => s.label === 'À Vista').valor), aVista)
  assert.equal(Number(acharSecao(secoes, 'A')?.sublinhas.find((s) => s.label === 'A Prazo').valor), aPrazo)
  assert.equal(Number(acharSecao(secoes, 'B')?.valor), deducoes)
  assert.equal(Number(acharSecao(secoes, 'C')?.valor), impostos)
  assert.equal(Number(acharSecao(secoes, 'D')?.valor), receitaLiquida)
  assert.equal(Number(acharSecao(secoes, 'E')?.valor), custoDireto)
  assert.equal(Number(acharSecao(secoes, 'F')?.valor), lucroBruto)
  assert.equal(Number(acharSecao(secoes, 'G')?.valor), despesasOperacionais)
  assert.equal(Number(acharSecao(secoes, 'H')?.valor), despesasFinanceiras)
  assert.equal(Number(acharSecao(secoes, 'I')?.valor), receitasFinanceiras)
  assert.equal(Number(acharSecao(secoes, 'J')?.valor), lucroOperacional)
  assert.equal(Number(acharSecao(secoes, 'K')?.valor), retiradas)
  assert.equal(Number(acharSecao(secoes, 'L')?.valor), lucroEfetivo)
})

test('GET /api/relatorios/dre — filtro de período exclui mês seguinte e mês vazio fica zerado', async () => {
  const rAgosto = await getDre(tokenAdmin, 'ano=2031&mes=8')
  assert.equal(Number(acharSecao(rAgosto.body.secoes, 'A')?.valor), 2000, 'agosto/2031 (NFE6) precisa aparecer isolado, sem nada de julho')

  const rSetembro = await getDre(tokenAdmin, 'ano=2031&mes=9')
  assert.ok(rSetembro.body.secoes.every((s) => Number(s.valor) === 0), 'mês sem nenhum dado precisa vir zerado, sem quebrar')
})

test('GET /api/relatorios/dre — ano inteiro (sem mes) agrega os 12 meses separadamente', async () => {
  const r = await getDre(tokenAdmin, 'ano=2031')
  assert.equal(r.status, 200)
  assert.equal(r.body.meses.length, 12)
  const julho = r.body.meses.find((m) => m.mes === 7)
  const agosto = r.body.meses.find((m) => m.mes === 8)
  assert.equal(Number(acharSecao(julho.secoes, 'A')?.valor), 1500)
  assert.equal(Number(acharSecao(agosto.secoes, 'A')?.valor), 2000)
})

test('GET /api/relatorios/dre — achado documentado: conta a pagar de Nota de Entrada não aparece em nenhuma seção', async () => {
  // fn_criar_nota_entrada nunca seta categoria_dre na conta_financeira que
  // gera (ver notas-entrada-fluxo.test.mjs e
  // docs/financeiro/decisoes-e-riscos-notas-entrada-dre.md) — calcularSecoesDoMes
  // só soma contas_financeiras filtrando por categoria_dre, então essa conta
  // fica invisível em TODAS as seções (nem operacional, nem financeira, nem
  // retirada). Este teste tranca o comportamento ATUAL — não decide se é
  // "certo"; ver o doc de riscos para o porquê de não ter uma correção óbvia
  // (risco de contar o custo da compra 2x, na compra E na venda).
  const antes = await getDre(tokenAdmin, 'ano=2031&mes=7')
  const secoesAntes = antes.body.secoes

  const { data: contaSemCategoria, error } = await supabase.from('contas_financeiras').insert({
    tipo: 'pagar', descricao: 'Conta gerada por nota de entrada (sem categoria_dre)', valor: 9999.99,
    vencimento: '2031-07-28', status: 'aberta', categoria: 'Fornecedor',
  }).select('id').single()
  assert.equal(error, null, JSON.stringify(error))
  contasCriadas.push(contaSemCategoria.id)

  const depois = await getDre(tokenAdmin, 'ano=2031&mes=7')
  const secoesDepois = depois.body.secoes

  for (const codigo of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L']) {
    assert.equal(
      Number(acharSecao(secoesDepois, codigo)?.valor), Number(acharSecao(secoesAntes, codigo)?.valor),
      `seção ${codigo} não pode mudar — conta sem categoria_dre precisa ficar invisível em toda seção`,
    )
  }
})
