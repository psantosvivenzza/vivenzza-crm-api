import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { supabase } from '../lib/supabase-admin.server.js'
import { adminOnly } from '../middleware/auth.js'

const router = Router()

const SELECT_FIELDS = 'id, nome, email, role, ativo, criado_em, meta_mensal, comissao_sem_meta, comissao_com_meta'

// GET /api/usuarios — listar (só admin)
router.get('/', adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select(SELECT_FIELDS)
      .order('criado_em', { ascending: true })

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/usuarios/:id — detalhe (só admin)
router.get('/:id', adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('usuarios')
      .select(SELECT_FIELDS)
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Usuário não encontrado' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/usuarios — criar (só admin)
router.post('/', adminOnly, async (req, res) => {
  try {
    const { nome, email, senha, role = 'vendedor', ativo = true, meta_mensal, comissao_sem_meta, comissao_com_meta } = req.body
    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: 'nome, email e senha são obrigatórios' })
    }

    const senha_hash = await bcrypt.hash(senha, 12)
    const insertData = { nome, email: email.toLowerCase().trim(), senha_hash, role, ativo }
    if (meta_mensal !== undefined) insertData.meta_mensal = meta_mensal
    if (comissao_sem_meta !== undefined) insertData.comissao_sem_meta = comissao_sem_meta
    if (comissao_com_meta !== undefined) insertData.comissao_com_meta = comissao_com_meta

    const { data, error } = await supabase
      .from('usuarios')
      .insert(insertData)
      .select(SELECT_FIELDS)
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/usuarios/:id — atualizar nome, email, senha, role, ativo (só admin)
router.patch('/:id', adminOnly, async (req, res) => {
  try {
    const { nome, email, senha, role, ativo, meta_mensal, comissao_sem_meta, comissao_com_meta } = req.body
    const updates = {}
    if (nome !== undefined) updates.nome = nome
    if (email !== undefined) updates.email = email.toLowerCase().trim()
    if (role !== undefined) updates.role = role
    if (ativo !== undefined) updates.ativo = ativo
    if (senha) updates.senha_hash = await bcrypt.hash(senha, 12)
    if (meta_mensal !== undefined) updates.meta_mensal = meta_mensal
    if (comissao_sem_meta !== undefined) updates.comissao_sem_meta = comissao_sem_meta
    if (comissao_com_meta !== undefined) updates.comissao_com_meta = comissao_com_meta

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ erro: 'Nenhum campo para atualizar' })
    }

    const { data, error } = await supabase
      .from('usuarios')
      .update(updates)
      .eq('id', req.params.id)
      .select(SELECT_FIELDS)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Usuário não encontrado' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
