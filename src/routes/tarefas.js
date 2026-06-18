import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/tarefas
router.get('/', async (req, res) => {
  try {
    const { lead_id, status, hoje, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('tarefas')
      .select('*, leads(id, nome)', { count: 'exact' })
      .order('prazo', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    // Vendedor só vê suas próprias tarefas
    if (req.user.role === 'vendedor') {
      query = query.eq('responsavel_id', req.user.id)
    }

    if (lead_id) query = query.eq('lead_id', lead_id)
    if (status) query = query.eq('status', status)

    if (hoje === 'true') {
      const agora = new Date()
      const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).toISOString()
      const fimDia   = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999).toISOString()
      query = query.gte('prazo', inicioDia).lte('prazo', fimDia).neq('status', 'concluida')
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
    const { lead_id, titulo, descricao, prazo, tipo = 'outro' } = req.body

    if (!titulo?.trim()) return res.status(400).json({ erro: 'Campo "titulo" é obrigatório' })

    const { data, error } = await supabase
      .from('tarefas')
      .insert({
        lead_id: lead_id || null,
        titulo,
        descricao: descricao || null,
        prazo: prazo || null,
        tipo,
        status: 'pendente',
        responsavel_id: req.user.id,
      })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/tarefas/:id — atualização parcial (ex: marcar concluída)
router.patch('/:id', async (req, res) => {
  try {
    const campos = { ...req.body }
    delete campos.id
    delete campos.criado_em
    delete campos.responsavel_id

    const { data, error } = await supabase
      .from('tarefas')
      .update(campos)
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

// PUT /api/tarefas/:id — atualização completa
router.put('/:id', async (req, res) => {
  try {
    const campos = { ...req.body }
    delete campos.id
    delete campos.criado_em
    delete campos.responsavel_id

    const { data, error } = await supabase
      .from('tarefas')
      .update(campos)
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
