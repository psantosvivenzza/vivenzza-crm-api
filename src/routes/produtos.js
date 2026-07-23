import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/produtos — listar produtos
router.get('/', async (req, res) => {
  try {
    const { ativo, linha_id, search, page = 1, limit = 200 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('produtos')
      .select('*, linhas(id, nome)', { count: 'exact' })
      .order('nome', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    if (ativo !== undefined && ativo !== 'todos') query = query.eq('ativo', ativo === 'true')
    if (linha_id) query = query.eq('linha_id', linha_id)
    if (search) query = query.or(`nome.ilike.%${search}%,sku.ilike.%${search}%`)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/produtos/linhas — listar linhas de produto
router.get('/linhas', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('linhas')
      .select('*')
      .eq('ativa', true)
      .order('nome')

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/produtos/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('produtos')
      .select('*, linhas(id, nome)')
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
    const { nome, sku, descricao, linha_id, preco_b2c, preco_b2b, preco_distribuidor, ativo = true } = req.body

    if (!nome) {
      return res.status(400).json({ erro: '"nome" é obrigatório' })
    }

    const { data, error } = await supabase
      .from('produtos')
      .insert({
        nome, sku, descricao, linha_id,
        preco_b2c: preco_b2c != null ? Number(preco_b2c) : null,
        preco_b2b: preco_b2b != null ? Number(preco_b2b) : null,
        preco_distribuidor: preco_distribuidor != null ? Number(preco_distribuidor) : null,
        ativo,
      })
      .select('*, linhas(id, nome)')
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
    const campos = { ...req.body }
    delete campos.id
    delete campos.criado_em

    if (campos.preco_b2c != null) campos.preco_b2c = Number(campos.preco_b2c)
    if (campos.preco_b2b != null) campos.preco_b2b = Number(campos.preco_b2b)
    if (campos.preco_distribuidor != null) campos.preco_distribuidor = Number(campos.preco_distribuidor)

    const { data, error } = await supabase
      .from('produtos')
      .update(campos)
      .eq('id', req.params.id)
      .select('*, linhas(id, nome)')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Produto não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
