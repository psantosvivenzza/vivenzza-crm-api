import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { adminOnly } from '../middleware/auth.js'

const router = Router()

// GET /api/notifications — não lidas do usuário logado, mais recentes primeiro
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notifications')
      .select('id, type, title, description, conversation_id, message_id, escalation_level, created_at, leads(nome)')
      .eq('user_id', req.user.id)
      .eq('is_read', false)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error

    res.json({ data: data || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/notifications/:id/read — marca uma notificação como lida
router.patch('/:id/read', async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id) // garante que só o dono da notificação pode marcá-la
    if (error) throw error

    res.json({ sucesso: true })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/notifications/read-all — marca todas as não lidas do usuário como lidas
router.patch('/read-all', async (req, res) => {
  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .eq('is_read', false)
    if (error) throw error

    res.json({ sucesso: true })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/notifications — interno (o job de monitoramento grava direto no banco,
// igual aos outros jobs do sistema); esse endpoint existe como via HTTP explícita
// pra testes manuais/integrações futuras, restrita a admin.
router.post('/', adminOnly, async (req, res) => {
  try {
    const { user_id, type, title, description, conversation_id, message_id, escalation_level } = req.body
    if (!user_id || !type || !title) {
      return res.status(400).json({ erro: 'Campos "user_id", "type" e "title" são obrigatórios' })
    }

    const { data, error } = await supabase
      .from('notifications')
      .insert({ user_id, type, title, description, conversation_id, message_id, escalation_level })
      .select()
      .single()
    if (error) throw error

    res.json({ data })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
