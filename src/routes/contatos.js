import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/contatos
router.get('/', async (req, res) => {
  try {
    const { lead_id, busca, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('contatos')
      .select('*', { count: 'exact' })
      .order('nome', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    if (lead_id) query = query.eq('lead_id', lead_id)
    if (busca) query = query.or(`nome.ilike.%${busca}%,email.ilike.%${busca}%,telefone.ilike.%${busca}%`)

    const { data, error, count } = await query

    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/contatos/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contatos')
      .select('*, leads(id, nome, etapa)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Contato não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/contatos
router.post('/', async (req, res) => {
  try {
    const { nome, email, telefone, empresa, cargo, lead_id, observacoes } = req.body

    if (!nome) return res.status(400).json({ erro: 'Campo "nome" é obrigatório' })

    const { data, error } = await supabase
      .from('contatos')
      .insert({ nome, email, telefone, empresa, cargo, lead_id, observacoes })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/contatos/:id
router.put('/:id', async (req, res) => {
  try {
    const campos = req.body
    delete campos.id
    delete campos.created_at

    const { data, error } = await supabase
      .from('contatos')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Contato não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// DELETE /api/contatos/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('contatos')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.status(204).send()
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
