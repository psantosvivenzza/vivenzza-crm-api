import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

const STATUS_VALIDOS = ['rascunho', 'confirmado', 'em_producao', 'enviado', 'entregue', 'cancelado']

// Select "leve" pra listagem — a tabela da lista só usa pedido_itens.length (não
// precisa de produtos aninhado); count:'exact' com o embed pesado original já dava
// timeout em produção com 9k+ pedidos / 55k+ itens, mesmo antes destas mudanças.
// O detalhe (GET /:id) usa o select completo abaixo.
// clientes_erp ao lado de leads: pedido novo usa cliente_erp_id, pedido antigo (migrado
// do legado) só tem lead_id — os dois embeds convivem, cada pedido só preenche um.
const SELECT_PEDIDO_LISTA = '*, leads(id, nome, empresa), clientes_erp(id, razao_social, nome_fantasia, cnpj_cpf), pedido_itens(id)'
const SELECT_PEDIDO_DETALHE = '*, leads(id, nome, empresa), clientes_erp(id, razao_social, nome_fantasia, cnpj_cpf), usuarios!pedidos_representante_id_fkey(id, nome), pedido_itens(*, produtos(id, nome, sku, preco_b2c, preco_b2b)), contas_financeiras(*)'

// Resolve o preço unitário do produto de acordo com a lista de preço do pedido.
// 'b2c'/'b2b'/'distribuidor' são as 3 colunas fixas; qualquer outro valor busca
// em produtos.extra_precos (as outras 10 listas migradas do legado).
function resolverPreco(produto, listaPreco) {
  if (listaPreco === 'b2c') return produto.preco_b2c ?? produto.preco_b2b ?? 0
  if (listaPreco === 'b2b') return produto.preco_b2b ?? produto.preco_b2c ?? 0
  if (listaPreco === 'distribuidor') return produto.preco_distribuidor ?? produto.preco_b2c ?? 0
  if (listaPreco && produto.extra_precos?.[listaPreco] != null) return produto.extra_precos[listaPreco]
  return produto.preco_b2c ?? produto.preco_b2b ?? 0
}

// Converte a condição de pagamento ("30/60/90", "a_vista", ...) na lista de dias
// de cada parcela. Formato não reconhecido cai em 1 parcela à vista — não trava a confirmação.
function gerarDiasParcelas(condicao) {
  if (!condicao || condicao === 'a_vista') return [0]
  if (/^\d+(\/\d+)*$/.test(condicao)) return condicao.split('/').map(Number)
  return [0]
}

// GET /api/pedidos — listar
router.get('/', async (req, res) => {
  try {
    const { status, lead_id, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    // count:'planned' (estimativa via estatísticas do Postgres) em vez de 'exact' —
    // a lista não usa o total pra nada hoje, e o exato exigia escanear/contar o
    // join inteiro (9k+ pedidos x 55k+ itens) a cada request.
    let query = supabase
      .from('pedidos')
      .select(SELECT_PEDIDO_LISTA, { count: 'planned' })
      .order('criado_em', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (status) query = query.eq('status', status)
    if (lead_id) query = query.eq('lead_id', lead_id)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/pedidos/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pedidos')
      .select(SELECT_PEDIDO_DETALHE)
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Pedido não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/pedidos — criar pedido com itens
router.post('/', async (req, res) => {
  try {
    const {
      cliente_erp_id, itens, observacoes, desconto = 0,
      condicao_pagamento, forma_pagamento, lista_preco,
      representante_id, representante_nome, comissao_percentual,
      valor_frete = 0, tipo_frete, peso_bruto, peso_liquido, qtde_volumes,
    } = req.body
    const usuario_id = req.user?.id

    if (!cliente_erp_id || !Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: '"cliente_erp_id" e ao menos um item são obrigatórios' })
    }

    // Busca preços dos produtos (inclui extra_precos pras listas migradas do legado)
    const ids = itens.map(i => i.produto_id)
    const { data: produtos, error: errProd } = await supabase
      .from('produtos')
      .select('id, preco_b2c, preco_b2b, preco_distribuidor, extra_precos')
      .in('id', ids)

    if (errProd) throw errProd

    const produtoMap = Object.fromEntries(produtos.map(p => [p.id, p]))

    let subtotal = 0
    const itensPreparados = itens.map(item => {
      const produto = produtoMap[item.produto_id] || {}
      const preco = item.preco_unitario ?? resolverPreco(produto, lista_preco)
      const quantidade = item.quantidade
      const sub = preco * quantidade
      subtotal += sub
      // subtotal NÃO entra aqui: pedido_itens.subtotal é GENERATED ALWAYS (quantidade * preco_unitario) no banco.
      return { produto_id: item.produto_id, quantidade, preco_unitario: preco }
    })

    const total = subtotal - Number(desconto) + Number(valor_frete)

    const { data: pedido, error: errPedido } = await supabase
      .from('pedidos')
      .insert({
        cliente_erp_id, usuario_id, total, desconto: Number(desconto), observacoes, status: 'rascunho',
        condicao_pagamento, forma_pagamento, lista_preco,
        representante_id: representante_id || null, representante_nome,
        comissao_percentual: comissao_percentual != null ? Number(comissao_percentual) : null,
        valor_frete: Number(valor_frete), tipo_frete,
        peso_bruto: peso_bruto != null ? Number(peso_bruto) : null,
        peso_liquido: peso_liquido != null ? Number(peso_liquido) : null,
        qtde_volumes: qtde_volumes != null ? Number(qtde_volumes) : null,
      })
      .select()
      .single()

    if (errPedido) throw errPedido

    const { error: errItens } = await supabase
      .from('pedido_itens')
      .insert(itensPreparados.map(i => ({ ...i, pedido_id: pedido.id })))

    if (errItens) throw errItens

    const { data: pedidoCompleto } = await supabase
      .from('pedidos')
      .select('*, pedido_itens(*, produtos(nome))')
      .eq('id', pedido.id)
      .single()

    res.status(201).json(pedidoCompleto)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/pedidos/:id/status — atualizar status
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body

    if (!status || !STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ erro: `Status inválido. Use: ${STATUS_VALIDOS.join(', ')}` })
    }

    const { data, error } = await supabase
      .from('pedidos')
      .update({ status, atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, leads(nome), clientes_erp(razao_social)')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Pedido não encontrado' })

    if (status === 'confirmado') {
      await gerarParcelas(data)
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// Gera as parcelas (contas_financeiras) do pedido confirmado — idempotente:
// não gera de novo se o pedido for confirmado mais de uma vez.
async function gerarParcelas(pedido) {
  const { count } = await supabase
    .from('contas_financeiras')
    .select('id', { count: 'exact', head: true })
    .eq('pedido_id', pedido.id)

  if (count > 0) return

  const dias = gerarDiasParcelas(pedido.condicao_pagamento)
  const n = dias.length
  const total = Number(pedido.total) || 0
  const hoje = new Date()

  let acumulado = 0
  const parcelas = dias.map((d, i) => {
    const ehUltima = i === n - 1
    const valor = ehUltima
      ? Math.round((total - acumulado) * 100) / 100
      : Math.round((total / n) * 100) / 100
    acumulado += valor

    const vencimento = new Date(hoje)
    vencimento.setDate(vencimento.getDate() + d)

    return {
      tipo: 'receber',
      pedido_id: pedido.id,
      descricao: `Pedido #${pedido.id.slice(-8).toUpperCase()} — Parcela ${i + 1}/${n}`,
      valor,
      vencimento: vencimento.toISOString().split('T')[0],
      status: 'aberta',
      categoria: 'Venda',
      pessoa_nome: pedido.clientes_erp?.razao_social ?? pedido.leads?.nome ?? null,
    }
  })

  await supabase.from('contas_financeiras').insert(parcelas)
}

export default router
