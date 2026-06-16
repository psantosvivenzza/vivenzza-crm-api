import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/produtos — listar produtos ativos
router.get('/', async (req, res) => {
  try {
    const { ativo = 'true', categoria, page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('produtos')
      .select('*', { count: 'exact' })
      .order('nome', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    if (ativo !== 'todos') query = query.eq('ativo', ativo === 'true')
    if (categoria) query = query.eq('categoria', categoria)

    const { data, error, count } = await query

    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/produtos/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('produtos')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Produto não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/produtos — criar
router.post('/', async (req, res) => {
  try {
    const { nome, descricao, preco, categoria, sku, ativo = true } = req.body

    if (!nome || preco == null) {
      return res.status(400).json({ erro: 'Campos "nome" e "preco" são obrigatórios' })
    }

    const { data, error } = await supabase
      .from('produtos')
      .insert({ nome, descricao, preco: Number(preco), categoria, sku, ativo })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/produtos/:id — atualizar
router.put('/:id', async (req, res) => {
  try {
    const campos = req.body
    delete campos.id
    delete campos.created_at

    if (campos.preco != null) campos.preco = Number(campos.preco)

    const { data, error } = await supabase
      .from('produtos')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Produto não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
