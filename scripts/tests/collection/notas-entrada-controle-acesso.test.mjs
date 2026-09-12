// Controle de acesso em POST /api/notas-entrada — decisão explícita do
// responsável (2026-09-08): quando a nota de entrada gera conta a pagar, só
// admin/financeiro podem executar; vendedor, papel desconhecido e token sem
// claim "role" são bloqueados ANTES de qualquer escrita ou chamada de RPC.
// Requisições que NÃO geram conta a pagar preservam o comportamento anterior
// (rota não tinha nenhuma restrição de papel).
//
// ATUALIZAÇÃO (2026-09-12): fn_criar_nota_entrada() e as tabelas
// notas_entrada/notas_entrada_itens/movimentacoes_estoque, que até então não
// existiam em nenhum SQL versionado do repositório (achado original desta
// nota, preservado no histórico do arquivo), agora estão versionadas em
// supabase/migrations/20260101000064-000066 (verbatim, confirmadas contra
// produção real — ver docs/financeiro/schema-real-producao-dre-notas-entrada.md)
// e no baseline de teste em scripts/localdb/schema-baseline/007_notas_entrada_dre.sql
// (produtos/nfe/nfe_itens/stubs). Os testes de admin/financeiro abaixo agora
// confirmam a execução completa (201 + nota real persistida), não só o gate
// de papel. Cobertura funcional mais ampla do fluxo (itens, estoque, custo,
// rollback) vive em notas-entrada-fluxo.test.mjs; grants/RLS de
// fn_criar_nota_entrada em notas-entrada-fn-criar-grants.test.mjs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

let supabase, server, porta
let idAdmin, idFinanceiro, idVendedorA, idTerceiroPapel, idProduto
let tokenAdmin, tokenFinanceiro, tokenVendedorA, tokenTerceiroPapel, tokenSemRole
const numerosNotaCriados = []

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'

  const sufixo = Date.now()
  async function criarUsuarioDeTeste(role, rotulo) {
    const { data, error } = await supabase.from('usuarios')
      .insert({ nome: `${rotulo} (teste nea)`, email: `${rotulo}-${sufixo}@teste-nea.local`, role, ativo: true })
      .select('id').single()
    if (error) throw error
    return data.id
  }
  idAdmin = await criarUsuarioDeTeste('admin', 'admin')
  idFinanceiro = await criarUsuarioDeTeste('financeiro', 'financeiro')
  idVendedorA = await criarUsuarioDeTeste('vendedor', 'vendedor-a')
  idTerceiroPapel = await criarUsuarioDeTeste('gerente', 'terceiro-papel') // papel desconhecido/não suportado

  // notas_entrada_itens.produto_id é FK NOT NULL real (sem ON DELETE) — as
  // requisições de escrita real (admin/financeiro) precisam de um produto
  // existente de verdade, diferente das requisições de negação (403), que
  // nunca alcançam a RPC (interceptor abaixo prova isso) e por isso ainda
  // podem usar um produto_id qualquer no corpo.
  const { data: produto, error: erroProduto } = await supabase.from('produtos')
    .insert({ nome: `Produto teste nea ${sufixo}` }).select('id').single()
  if (erroProduto) throw erroProduto
  idProduto = produto.id

  tokenAdmin = jwt.sign({ id: idAdmin, email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)
  tokenFinanceiro = jwt.sign({ id: idFinanceiro, email: 'financeiro@teste.com', role: 'financeiro' }, process.env.JWT_SECRET)
  tokenVendedorA = jwt.sign({ id: idVendedorA, email: 'a@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenTerceiroPapel = jwt.sign({ id: idTerceiroPapel, email: 'terceiro@teste.com', role: 'gerente' }, process.env.JWT_SECRET)
  tokenSemRole = jwt.sign({ id: idAdmin, email: 'sem-role@teste.com' }, process.env.JWT_SECRET) // sem claim "role"

  const express = (await import('express')).default
  const { auth } = await import('../../../src/middleware/auth.js')
  const router = (await import('../../../src/routes/notas-entrada.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/notas-entrada', auth, router) // mesmo mount de src/index.js
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
  await supabase.from('produtos').delete().eq('id', idProduto)
  await supabase.from('usuarios').delete().in('id', [idAdmin, idFinanceiro, idVendedorA, idTerceiroPapel])
  await pararAmbienteDeTeste()
})

function chamar(method, path, { token = tokenAdmin, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { authorization: `Bearer ${token}` }
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

async function contarContasComMarcador(marcador) {
  const { count, error } = await supabase
    .from('contas_financeiras')
    .select('id', { count: 'exact', head: true })
    .ilike('documento_ref', `%${marcador}%`)
  if (error) throw error
  return count
}

// Interceptor real de supabase.rpc/supabase.from — prova por INSTRUMENTAÇÃO,
// não por inferência, que nenhuma chamada ao Supabase (RPC ou tabela) é
// alcançada depois de uma negação de autorização. Necessário porque, neste
// ambiente, fn_criar_nota_entrada nem existe (ver comentário do topo do
// arquivo) — "nenhuma conta foi criada" sozinho não prova que o código nunca
// TENTOU chamar a RPC, só que a tentativa (se houve) falhou por outro motivo.
// Troca os métodos do MESMO objeto `supabase` importado por notas-entrada.js
// (módulos ES são singletons — o require cacheado é idêntico) por versões
// que registram a chamada E lançam, então se o gate falhar e o código
// alcançar supabase.rpc/from mesmo assim, a rota captura o throw no seu
// try/catch e devolve 500 — o teste então falha tanto na asserção de status
// (403 esperado) quanto na de `chamadas.length`, nunca passa por acidente.
function instalarInterceptorSupabase() {
  const rpcOriginal = supabase.rpc
  const fromOriginal = supabase.from
  const chamadas = []
  supabase.rpc = (...args) => {
    chamadas.push({ metodo: 'rpc', nome: args[0] })
    throw new Error(`INTERCEPTADO: supabase.rpc("${args[0]}") foi chamado após uma negação de autorização — não deveria`)
  }
  supabase.from = (...args) => {
    chamadas.push({ metodo: 'from', tabela: args[0] })
    throw new Error(`INTERCEPTADO: supabase.from("${args[0]}") foi chamado após uma negação de autorização — não deveria`)
  }
  return {
    chamadas,
    remover() { supabase.rpc = rpcOriginal; supabase.from = fromOriginal },
  }
}

async function chamarNegacaoComInterceptor(body, token) {
  const interceptor = instalarInterceptorSupabase()
  try {
    const r = await chamar('POST', '/api/notas-entrada', { token, body })
    return { r, chamadas: interceptor.chamadas }
  } finally {
    interceptor.remover()
  }
}

test('POST /api/notas-entrada — gera conta a pagar exige admin/financeiro antes de qualquer escrita/RPC', async (tSuite) => {
  await tSuite.test('vendedor é bloqueado (403) quando gerar_conta_pagar=true, mesmo com corpo mínimo — supabase.rpc/from NUNCA chamados (interceptor)', async () => {
    const { r, chamadas } = await chamarNegacaoComInterceptor({ gerar_conta_pagar: true }, tokenVendedorA)
    assert.equal(r.status, 403)
    assert.equal(r.body.id, undefined, 'resposta de bloqueio não pode conter id de nota criada')
    assert.deepEqual(chamadas, [], 'nenhuma chamada a supabase.rpc/from pode ser alcançada após a negação')
  })

  await tSuite.test('papel desconhecido (gerente) é bloqueado (403) quando gerar_conta_pagar=true — supabase.rpc/from NUNCA chamados (interceptor)', async () => {
    const { r, chamadas } = await chamarNegacaoComInterceptor({ gerar_conta_pagar: true }, tokenTerceiroPapel)
    assert.equal(r.status, 403)
    assert.deepEqual(chamadas, [], 'nenhuma chamada a supabase.rpc/from pode ser alcançada após a negação')
  })

  await tSuite.test('token sem claim "role" é bloqueado (403) quando gerar_conta_pagar=true — supabase.rpc/from NUNCA chamados (interceptor)', async () => {
    const { r, chamadas } = await chamarNegacaoComInterceptor({ gerar_conta_pagar: true }, tokenSemRole)
    assert.equal(r.status, 403)
    assert.deepEqual(chamadas, [], 'nenhuma chamada a supabase.rpc/from pode ser alcançada após a negação')
  })

  await tSuite.test('valor "truthy" não-booleano (string) é tratado igual a true — mesma coerção !! usada na autorização e na RPC — supabase.rpc/from NUNCA chamados (interceptor)', async () => {
    // Garante que não há divergência por tipo/valor: um vendedor não pode
    // escapar do bloqueio mandando gerar_conta_pagar:"sim" só porque não é
    // estritamente `=== true`.
    const { r, chamadas } = await chamarNegacaoComInterceptor({ gerar_conta_pagar: 'sim' }, tokenVendedorA)
    assert.equal(r.status, 403)
    assert.deepEqual(chamadas, [], 'nenhuma chamada a supabase.rpc/from pode ser alcançada após a negação')
  })

  await tSuite.test('nenhuma conta a pagar é criada após negação — prova dupla: interceptor (nenhuma chamada alcançada) + contas_financeiras inalterada', async () => {
    // notas_entrada/notas_entrada_itens/movimentacoes_estoque não existem
    // neste banco (nem em nenhum lugar do repo) — não há como consultá-las
    // diretamente. Por isso a prova principal aqui é o INTERCEPTOR (ver
    // chamarNegacaoComInterceptor) — não apenas "contas_financeiras não
    // mudou", que sozinho seria insuficiente num ambiente onde a própria RPC
    // não existe (uma tentativa de chamada falharia de qualquer forma, com
    // ou sem gate, então "nada foi criado" não prova que o gate rodou
    // primeiro). O interceptor prova a ordem de execução; a contagem abaixo
    // é uma segunda confirmação independente, no que existe localmente.
    const marcador = `NEA-NEGADO-${Date.now()}`
    const antes = await contarContasComMarcador(marcador)
    const { r, chamadas } = await chamarNegacaoComInterceptor({
      numero_nota: marcador, fornecedor_nome: 'Fornecedor Teste NEA',
      data_emissao: new Date().toISOString().slice(0, 10), valor_total: 500,
      gerar_conta_pagar: true, vencimento: new Date().toISOString().slice(0, 10),
      itens: [{ produto_id: '00000000-0000-0000-0000-000000000000', quantidade: 1, valor_unitario: 500 }],
    }, tokenVendedorA)
    assert.equal(r.status, 403)
    assert.deepEqual(chamadas, [], 'nenhuma chamada a supabase.rpc/from pode ser alcançada após a negação')
    const depois = await contarContasComMarcador(marcador)
    assert.equal(depois, antes, 'nenhuma conta_financeira nova após bloqueio')
  })

  await tSuite.test('admin: gate de papel autoriza e a nota é criada de verdade (201, conta a pagar gerada)', async () => {
    const numeroNota = `NEA-ADMIN-${Date.now()}`
    const r = await chamar('POST', '/api/notas-entrada', {
      token: tokenAdmin,
      body: {
        numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Teste NEA',
        data_emissao: new Date().toISOString().slice(0, 10), valor_total: 500,
        gerar_conta_pagar: true, vencimento: new Date().toISOString().slice(0, 10),
        itens: [{ produto_id: idProduto, quantidade: 1, valor_unitario: 500 }],
      },
    })
    numerosNotaCriados.push(numeroNota)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.ok(r.body.conta_financeira_id, 'gerar_conta_pagar=true precisa gerar conta_financeira_id')
  })

  await tSuite.test('financeiro: gate de papel autoriza e a nota é criada de verdade (201, conta a pagar gerada)', async () => {
    const numeroNota = `NEA-FIN-${Date.now()}`
    const r = await chamar('POST', '/api/notas-entrada', {
      token: tokenFinanceiro,
      body: {
        numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Teste NEA',
        data_emissao: new Date().toISOString().slice(0, 10), valor_total: 500,
        gerar_conta_pagar: true, vencimento: new Date().toISOString().slice(0, 10),
        itens: [{ produto_id: idProduto, quantidade: 1, valor_unitario: 500 }],
      },
    })
    numerosNotaCriados.push(numeroNota)
    assert.equal(r.status, 201, JSON.stringify(r.body))
    assert.ok(r.body.conta_financeira_id, 'gerar_conta_pagar=true precisa gerar conta_financeira_id')
  })
})

test('POST /api/notas-entrada — sem geração de conta a pagar preserva o comportamento anterior (sem restrição de papel)', async (tSuite) => {
  await tSuite.test('vendedor NÃO é bloqueado pelo novo gate quando gerar_conta_pagar é false — nota criada normalmente (201)', async () => {
    const numeroNota = `NEA-SEMFIN-${Date.now()}`
    const r = await chamar('POST', '/api/notas-entrada', {
      token: tokenVendedorA,
      body: {
        numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Teste NEA',
        data_emissao: new Date().toISOString().slice(0, 10), valor_total: 500,
        gerar_conta_pagar: false,
        itens: [{ produto_id: idProduto, quantidade: 1, valor_unitario: 500 }],
      },
    })
    numerosNotaCriados.push(numeroNota)
    assert.equal(r.status, 201, 'sem geração de conta a pagar, o novo gate não pode bloquear — mesmo comportamento de antes desta mudança (rota nunca teve restrição de papel)')
  })

  await tSuite.test('vendedor NÃO é bloqueado pelo novo gate quando gerar_conta_pagar está ausente do corpo — nota criada normalmente (201)', async () => {
    const numeroNota = `NEA-AUSENTE-${Date.now()}`
    const r = await chamar('POST', '/api/notas-entrada', {
      token: tokenVendedorA,
      body: {
        numero_nota: numeroNota, fornecedor_nome: 'Fornecedor Teste NEA',
        data_emissao: new Date().toISOString().slice(0, 10), valor_total: 500,
        itens: [{ produto_id: idProduto, quantidade: 1, valor_unitario: 500 }],
      },
    })
    numerosNotaCriados.push(numeroNota)
    assert.equal(r.status, 201, 'gerar_conta_pagar ausente equivale a false via !! — não pode ser bloqueado')
  })

  await tSuite.test('papel desconhecido e token sem role também não são bloqueados pelo novo gate quando não há geração financeira — notas criadas normalmente (201)', async () => {
    const corpo = (marca) => ({
      numero_nota: `NEA-${marca}-${Date.now()}`, fornecedor_nome: 'Fornecedor Teste NEA',
      data_emissao: new Date().toISOString().slice(0, 10), valor_total: 500,
      itens: [{ produto_id: idProduto, quantidade: 1, valor_unitario: 500 }],
    })
    const corpo1 = corpo('GERENTE')
    const r1 = await chamar('POST', '/api/notas-entrada', { token: tokenTerceiroPapel, body: corpo1 })
    numerosNotaCriados.push(corpo1.numero_nota)
    assert.equal(r1.status, 201)
    const corpo2 = corpo('SEMROLE')
    const r2 = await chamar('POST', '/api/notas-entrada', { token: tokenSemRole, body: corpo2 })
    numerosNotaCriados.push(corpo2.numero_nota)
    assert.equal(r2.status, 201)
  })
})
