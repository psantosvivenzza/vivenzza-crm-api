import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/estoque — saldo atual de todos os produtos
router.get('/', async (req, res) => {
  try {
    const { categoria, alerta, page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('estoque')
      .select(`
        *,
        produtos(id, nome, sku, categoria, preco, ativo)
      `, { count: 'exact' })
      .order('updated_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    const { data, error, count } = await query
    if (error) throw error

    let resultado = data

    if (categoria) {
      resultado = resultado.filter(e => e.produtos?.categoria === categoria)
    }

    if (alerta === 'true') {
      resultado = resultado.filter(e => e.quantidade <= e.quantidade_minima)
    }

    res.json({ data: resultado, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/estoque/alertas — produtos abaixo do mínimo
router.get('/alertas', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('estoque')
      .select('*, produtos(id, nome, sku, categoria)')
      .filter('quantidade', 'lte', supabase.raw('quantidade_minima'))

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/estoque/produto/:produto_id — saldo de um produto
router.get('/produto/:produto_id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('estoque')
      .select('*, produtos(id, nome, sku, categoria)')
      .eq('produto_id', req.params.produto_id)
      .single()

    if (error && error.code !== 'PGRST116') throw error
    res.json(data || { produto_id: req.params.produto_id, quantidade: 0, quantidade_minima: 0 })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/estoque/movimentacoes — histórico
router.get('/movimentacoes', async (req, res) => {
  try {
    const { produto_id, tipo, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('movimentacoes_estoque')
      .select(`
        *,
        produtos(id, nome, sku),
        usuarios(id, nome)
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (produto_id) query = query.eq('produto_id', produto_id)
    if (tipo) query = query.eq('tipo', tipo)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/estoque/entrada — registrar entrada
router.post('/entrada', async (req, res) => {
  try {
    const { produto_id, quantidade, motivo, documento_ref } = req.body
    const usuario_id = req.user?.id

    if (!produto_id || !quantidade || Number(quantidade) <= 0) {
      return res.status(400).json({ erro: '"produto_id" e "quantidade" positiva são obrigatórios' })
    }

    const { data, error } = await supabase
      .from('movimentacoes_estoque')
      .insert({ produto_id, quantidade: Number(quantidade), tipo: 'entrada', motivo, documento_ref, usuario_id })
      .select('*, produtos(nome)')
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/estoque/saida — registrar saída
router.post('/saida', async (req, res) => {
  try {
    const { produto_id, quantidade, motivo, documento_ref } = req.body
    const usuario_id = req.user?.id

    if (!produto_id || !quantidade || Number(quantidade) <= 0) {
      return res.status(400).json({ erro: '"produto_id" e "quantidade" positiva são obrigatórios' })
    }

    const { data: saldo } = await supabase
      .from('estoque')
      .select('quantidade')
      .eq('produto_id', produto_id)
      .single()

    if ((saldo?.quantidade ?? 0) < Number(quantidade)) {
      return res.status(400).json({ erro: 'Saldo insuficiente em estoque' })
    }

    const { data, error } = await supabase
      .from('movimentacoes_estoque')
      .insert({ produto_id, quantidade: Number(quantidade), tipo: 'saida', motivo, documento_ref, usuario_id })
      .select('*, produtos(nome)')
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/estoque/ajuste — ajuste de inventário (define saldo absoluto)
router.post('/ajuste', async (req, res) => {
  try {
    const { produto_id, quantidade, motivo } = req.body
    const usuario_id = req.user?.id

    if (!produto_id || quantidade == null) {
      return res.status(400).json({ erro: '"produto_id" e "quantidade" são obrigatórios' })
    }

    const { data, error } = await supabase
      .from('movimentacoes_estoque')
      .insert({ produto_id, quantidade: Number(quantidade), tipo: 'ajuste', motivo: motivo || 'Ajuste manual', usuario_id })
      .select('*, produtos(nome)')
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/estoque/produto/:produto_id/config — atualizar mínimo e localização
router.put('/produto/:produto_id/config', async (req, res) => {
  try {
    const { quantidade_minima, unidade, localizacao } = req.body

    const update = {}
    if (quantidade_minima != null) update.quantidade_minima = Number(quantidade_minima)
    if (unidade) update.unidade = unidade
    if (localizacao != null) update.localizacao = localizacao
    update.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('estoque')
      .upsert({ produto_id: req.params.produto_id, ...update }, { onConflict: 'produto_id' })
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
