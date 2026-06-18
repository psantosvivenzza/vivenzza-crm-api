import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { query as dbQuery } from '../lib/db.js'

const router = Router()

const useDb = () => !!process.env.DATABASE_URL

// GET /api/leads — listar com filtros opcionais
router.get('/', async (req, res) => {
  try {
    const { etapa, tipo, desde, origem, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('leads')
      .select('*, usuarios!leads_responsavel_id_fkey(id, nome)', { count: 'exact' })
      .order('criado_em', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (etapa) query = query.eq('etapa', etapa)
    if (tipo) query = query.eq('tipo', tipo)
    if (desde) query = query.gt('criado_em', desde)
    if (origem) query = query.eq('origem', origem)

    // Vendedor só vê os leads atribuídos a ele
    if (req.user.role === 'vendedor') {
      query = query.eq('responsavel_id', req.user.id)
    }

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
    const { nome, email, telefone, empresa, etapa = 'novo', tipo, valor, observacoes, origem } = req.body

    if (!nome) return res.status(400).json({ erro: 'Campo "nome" é obrigatório' })

    // Insert na tabela leads (sem email/telefone — ficam em contatos)
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .insert({ nome, empresa, etapa, tipo, valor, observacoes, origem })
      .select()
      .single()

    if (leadError) throw leadError

    // Se email ou telefone fornecidos, cria contato principal vinculado ao lead
    if (email || telefone) {
      const { error: contatoError } = await supabase
        .from('contatos')
        .insert({ lead_id: lead.id, nome, telefone: telefone || null, email: email || null, principal: true })

      if (contatoError) throw contatoError
    }

    res.status(201).json(lead)
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
