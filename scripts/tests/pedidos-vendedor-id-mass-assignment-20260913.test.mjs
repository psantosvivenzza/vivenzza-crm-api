// Auditoria adversarial de mass assignment de campo de identidade/posse
// (2026-09-13) — achado independente das PRs #87-#92 (auth/avaliacoes/
// leads-delete/meta-report/contatos — nenhuma toca src/routes/pedidos.js),
// do piloto "Meu Ponto" e do domínio financeiro (financeiro.js/cobrancas.js)
// já cobertos antes desta sessão.
//
// src/routes/pedidos.js já estabelece, em TODO outro endpoint do arquivo
// (GET /, GET /:id, PUT /:id, POST /:id/duplicar), que a posse de um
// vendedor sobre um pedido é sempre `pedido.vendedor_id === req.user.id` —
// é o modelo de identidade do arquivo inteiro. Mas POST /api/pedidos
// (criação) aceitava `vendedor_id` cru do corpo da requisição, sem
// normalização nem checagem de papel — um vendedor autenticado conseguia
// criar um pedido (e, depois de faturado, a comissão gerada em
// lib/comissoes.js::gerarComissao, que confia 100% em pedidos.vendedor_id)
// atribuído a QUALQUER outro usuário só passando `vendedor_id` no body,
// sem o consentimento nem o conhecimento do vendedor-alvo. O próprio pedido
// criado ficava inacessível a quem de fato o criou em GET /:id (a posse é
// checada contra vendedor_id) — sintoma direto de que o dado persistido não
// reflete a autoria real da ação. Essa consequência em GET /:id não é
// exercida aqui (SELECT_PEDIDO_DETALHE usa embed aninhado em 2 níveis,
// fora do que o compat client local suporta — ver nota antes de
// buscarPedidoPorMarcador); a prova decisiva é a leitura direta do
// `vendedor_id` persistido no banco logo após o POST.
//
// Corrigido: quando req.user.role === 'vendedor', vendedor_id é sempre
// forçado para req.user.id na criação (ignora qualquer valor enviado no
// corpo) — mesmo padrão já usado em src/routes/ligacoes.js (vendedor_id:
// req.user.id) e src/routes/tarefas.js (responsavel_id: req.user.id) na
// criação. Admin continua podendo atribuir vendedor_id explicitamente —
// comportamento já coberto por scripts/testes-pedidos-permissoes.mjs
// (teste 12, cria pedido via admin com vendedor_id de um vendedor
// específico) e preservado aqui sem alteração.
//
// Postgres exclusivo desta suíte (nunca 5432/5433/vivenzza_dev, nunca
// produção): porta/banco definidos via LOCAL_PG_PORT/LOCAL_PG_DATABASE no
// ambiente antes de rodar. scripts/localdb/schema-baseline/
// 007_pedidos_vendedor_id_test_only.sql adiciona pedidos/produtos/
// pedido_itens/pedido_historico ao baseline local — essas tabelas existem
// em produção mas nunca tiveram migration git-versionada (mesmo gap já
// documentado para avaliacoes_loja/contatos); colunas reconstruídas a
// partir da leitura integral de src/routes/pedidos.js, não de
// introspecção de produção (sem acesso nesta sessão) — ver cabeçalho do
// próprio arquivo .sql.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-pedidos-vendedor-id-nao-e-producao'

let servidor, porta, supabase
const usuarioIdsCriados = []
const pedidoIdsCriados = []
let produtoId, clienteErpId
let VENDEDOR_A, VENDEDOR_B, ADMIN_ID

before(async () => {
  const expressModule = await import('express')
  const express = expressModule.default
  const pedidosRouter = (await import('../../src/routes/pedidos.js')).default
  const { auth } = await import('../../src/middleware/auth.js')
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))

  const app = express()
  app.use(express.json())
  // Mesmo mount de src/index.js: app.use('/api/pedidos', auth, pedidosRouter).
  app.use('/api/pedidos', auth, pedidosRouter)

  servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  porta = servidor.address().port

  const sufixo = Date.now()
  const criarUsuario = async (nome, role) => {
    const { data, error } = await supabase
      .from('usuarios')
      .insert({ nome, email: `${nome}-${sufixo}@teste.com`, role })
      .select('id')
      .single()
    if (error) throw error
    usuarioIdsCriados.push(data.id)
    return data.id
  }
  VENDEDOR_A = await criarUsuario('vendedor-a-mass-assignment-teste', 'vendedor')
  VENDEDOR_B = await criarUsuario('vendedor-b-mass-assignment-teste', 'vendedor')
  ADMIN_ID = await criarUsuario('admin-mass-assignment-teste', 'admin')

  const { data: produto, error: erroProduto } = await supabase
    .from('produtos')
    .insert({ nome: `Produto Teste ${sufixo}`, preco_b2c: 10 })
    .select('id')
    .single()
  if (erroProduto) throw erroProduto
  produtoId = produto.id

  const { data: cliente, error: erroCliente } = await supabase
    .from('clientes_erp')
    .insert({ legacy_id: `TESTE-PEDIDO-${sufixo}`, tipo: 'PJ', razao_social: `Cliente Teste ${sufixo}` })
    .select('id')
    .single()
  if (erroCliente) throw erroCliente
  clienteErpId = cliente.id
})

after(async () => {
  if (pedidoIdsCriados.length) {
    await supabase.from('pedido_historico').delete().in('pedido_id', pedidoIdsCriados)
    await supabase.from('pedido_itens').delete().in('pedido_id', pedidoIdsCriados)
    await supabase.from('pedidos').delete().in('id', pedidoIdsCriados)
  }
  if (produtoId) await supabase.from('produtos').delete().eq('id', produtoId)
  if (clienteErpId) await supabase.from('clientes_erp').delete().eq('id', clienteErpId)
  if (usuarioIdsCriados.length) await supabase.from('usuarios').delete().in('id', usuarioIdsCriados)
  await new Promise((resolve) => servidor.close(resolve))
})

function chamar(method, caminho, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    if (body) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port: porta, method, path: caminho, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

const tokenVendedor = (id) => jwt.sign({ id, email: `${id}@teste.com`, role: 'vendedor' }, process.env.JWT_SECRET)
const tokenAdmin = (id) => jwt.sign({ id, email: `${id}@teste.com`, role: 'admin' }, process.env.JWT_SECRET)

async function pedidoAtual(id) {
  const { data } = await supabase.from('pedidos').select('*').eq('id', id).maybeSingle()
  return data
}

let contadorMarcador = 0
function corpoPedido(overrides = {}) {
  contadorMarcador++
  const marcador = `TESTE MASS ASSIGNMENT vendedor_id ${Date.now()}-${contadorMarcador} - APAGAR`
  return {
    marcador,
    body: {
      cliente_erp_id: clienteErpId,
      observacoes: marcador,
      itens: [{ produto_id: produtoId, quantidade: 1, preco_unitario: 10 }],
      ...overrides,
    },
  }
}

// O compat client local do Postgres (src/lib/localdev/pgCompatClient.js) não
// suporta embed aninhado em 2 níveis (`pedido_itens(*, produtos(nome))`,
// usado no SELECT final de POST /api/pedidos) — limitação documentada e
// preexistente do adaptador, não relacionada a este achado. O erro de SQL
// resultante é engolido por QueryBuilder._run() (vira {data:null, error}) e a
// rota não verifica `error` nesse ponto — por isso o corpo da resposta de
// criação é sempre `null` neste ambiente de teste local, mesmo com a criação
// tendo funcionado (status 201). Por isso os testes abaixo nunca dependem do
// corpo da resposta: buscam o pedido recém-criado direto no banco pelo
// `observacoes` (marcador único por teste).
async function buscarPedidoPorMarcador(marcador) {
  const { data, error } = await supabase.from('pedidos').select('*').eq('observacoes', marcador).single()
  if (error) throw error
  pedidoIdsCriados.push(data.id)
  return data
}

test('POST /api/pedidos — vendedor NÃO consegue atribuir o pedido a outro vendedor via vendedor_id no body (achado)', async () => {
  const { marcador, body } = corpoPedido({ vendedor_id: VENDEDOR_B })
  const r = await chamar('POST', '/api/pedidos', { token: tokenVendedor(VENDEDOR_A), body })
  assert.equal(r.status, 201)

  const pedido = await buscarPedidoPorMarcador(marcador)
  assert.equal(pedido.vendedor_id, VENDEDOR_A, 'vendedor_id precisa ser sempre quem de fato criou o pedido (vendedor autenticado), nunca o valor enviado no corpo')
  assert.notEqual(pedido.vendedor_id, VENDEDOR_B, 'o pedido não pode ter sido atribuído ao vendedor B, que não fez a requisição')
})

test('POST /api/pedidos — vendedor que cria pedido sem informar vendedor_id fica como dono (antes ficava sem vendedor nenhum)', async () => {
  const { marcador, body } = corpoPedido()
  const r = await chamar('POST', '/api/pedidos', { token: tokenVendedor(VENDEDOR_A), body })
  assert.equal(r.status, 201)

  const pedido = await buscarPedidoPorMarcador(marcador)
  assert.equal(pedido.vendedor_id, VENDEDOR_A)
})

test('POST /api/pedidos — admin continua podendo atribuir vendedor_id explicitamente (comportamento existente preservado)', async () => {
  const { marcador, body } = corpoPedido({ vendedor_id: VENDEDOR_A })
  const r = await chamar('POST', '/api/pedidos', { token: tokenAdmin(ADMIN_ID), body })
  assert.equal(r.status, 201)

  const pedido = await buscarPedidoPorMarcador(marcador)
  assert.equal(pedido.vendedor_id, VENDEDOR_A, 'admin precisa continuar conseguindo atribuir o pedido a um vendedor específico')
})

test('POST /api/pedidos — admin criando sem vendedor_id continua resultando em pedido sem vendedor (comportamento existente preservado)', async () => {
  const { marcador, body } = corpoPedido()
  const r = await chamar('POST', '/api/pedidos', { token: tokenAdmin(ADMIN_ID), body })
  assert.equal(r.status, 201)

  const pedido = await buscarPedidoPorMarcador(marcador)
  assert.equal(pedido.vendedor_id, null)
})
