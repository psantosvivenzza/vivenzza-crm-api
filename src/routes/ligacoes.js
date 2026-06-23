import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// POST /api/ligacoes — registra o início de uma ligação (ex: clique em "Ligar via WhatsApp")
router.post('/', async (req, res) => {
  try {
    const { lead_id, telefone, canal = 'whatsapp' } = req.body
    if (!telefone) return res.status(400).json({ erro: 'Campo "telefone" é obrigatório' })

    const { data, error } = await supabase
      .from('ligacoes')
      .insert({
        lead_id: lead_id || null,
        telefone,
        vendedor_id: req.user.id,
        canal,
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
