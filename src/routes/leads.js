import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/leads — listar com filtros opcionais
router.get('/', async (req, res) => {
  try {
    const { etapa, tipo, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('leads')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (etapa) query = query.eq('etapa', etapa)
    if (tipo) query = query.eq('tipo', tipo)

    const { data, error, count } = await query

    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/leads/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*, tarefas(*), whatsapp_mensagens(id, direcao, mensagem, created_at)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/leads — criar
router.post('/', async (req, res) => {
  try {
    const { nome, email, telefone, empresa, etapa = 'novo', tipo, valor_negociacao, observacoes } = req.body

    if (!nome) return res.status(400).json({ erro: 'Campo "nome" é obrigatório' })

    const { data, error } = await supabase
      .from('leads')
      .insert({ nome, email, telefone, empresa, etapa, tipo, valor_negociacao, observacoes })
      .select()
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/leads/:id — atualizar
router.put('/:id', async (req, res) => {
  try {
    const campos = req.body
    delete campos.id
    delete campos.created_at

    const { data, error } = await supabase
      .from('leads')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/leads/:id/etapa — mover no pipeline
router.put('/:id/etapa', async (req, res) => {
  try {
    const { etapa } = req.body

    const etapasValidas = ['novo', 'contato', 'proposta', 'negociacao', 'fechado', 'perdido']
    if (!etapa || !etapasValidas.includes(etapa)) {
      return res.status(400).json({ erro: `Etapa inválida. Use: ${etapasValidas.join(', ')}` })
    }

    const { data, error } = await supabase
      .from('leads')
      .update({ etapa, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// DELETE /api/leads/:id — remover
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.status(204).send()
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
