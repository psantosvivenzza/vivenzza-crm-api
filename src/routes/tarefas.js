import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/tarefas — listar com filtros
router.get('/', async (req, res) => {
  try {
    const { lead_id, status, vencendo_hoje, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('tarefas')
      .select('*, leads(id, nome)', { count: 'exact' })
      .order('data_vencimento', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    if (lead_id) query = query.eq('lead_id', lead_id)
    if (status) query = query.eq('status', status)

    if (vencendo_hoje === 'true') {
      const hoje = new Date().toISOString().split('T')[0]
      query = query.lte('data_vencimento', `${hoje}T23:59:59`).neq('status', 'concluida')
    }

    const { data, error, count } = await query

    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/tarefas/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tarefas')
      .select('*, leads(id, nome, etapa)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Tarefa não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/tarefas
router.post('/', async (req, res) => {
  try {
    const { lead_id, titulo, descricao, data_vencimento, prioridade = 'media' } = req.body

    if (!titulo) return res.status(400).json({ erro: 'Campo "titulo" é obrigatório' })

    const { data, error } = await supabase
      .from('tarefas')
      .insert({ lead_id, titulo, descricao, data_vencimento, prioridade, status: 'pendente' })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/tarefas/:id
router.put('/:id', async (req, res) => {
  try {
    const campos = req.body
    delete campos.id
    delete campos.created_at

    const { data, error } = await supabase
      .from('tarefas')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Tarefa não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// DELETE /api/tarefas/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('tarefas')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.status(204).send()
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
