import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

const STATUS_VALIDOS = ['rascunho', 'confirmado', 'em_producao', 'enviado', 'entregue', 'cancelado']

// GET /api/pedidos — listar
router.get('/', async (req, res) => {
  try {
    const { status, lead_id, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('pedidos')
      .select('*, leads(id, nome, telefone), itens_pedido(*, produtos(nome, preco))', { count: 'exact' })
      .order('created_at', { ascending: false })
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
      .select('*, leads(id, nome, telefone, email), itens_pedido(*, produtos(*))')
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
    const { lead_id, itens, observacoes, desconto = 0 } = req.body

    if (!lead_id || !Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: '"lead_id" e ao menos um item são obrigatórios' })
    }

    // Busca preços dos produtos para calcular total
    const ids = itens.map(i => i.produto_id)
    const { data: produtos, error: errProd } = await supabase
      .from('produtos')
      .select('id, preco')
      .in('id', ids)

    if (errProd) throw errProd

    const precoMap = Object.fromEntries(produtos.map(p => [p.id, p.preco]))

    let subtotal = 0
    const itensPreparados = itens.map(item => {
      const preco = item.preco_unitario ?? precoMap[item.produto_id] ?? 0
      subtotal += preco * item.quantidade
      return { produto_id: item.produto_id, quantidade: item.quantidade, preco_unitario: preco }
    })

    const total = subtotal - Number(desconto)

    const { data: pedido, error: errPedido } = await supabase
      .from('pedidos')
      .insert({ lead_id, total, desconto: Number(desconto), observacoes, status: 'rascunho' })
      .select()
      .single()

    if (errPedido) throw errPedido

    const { error: errItens } = await supabase
      .from('itens_pedido')
      .insert(itensPreparados.map(i => ({ ...i, pedido_id: pedido.id })))

    if (errItens) throw errItens

    const { data: pedidoCompleto } = await supabase
      .from('pedidos')
      .select('*, itens_pedido(*, produtos(nome))')
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
      .update({ status, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Pedido não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
