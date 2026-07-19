import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/admin/avaliacoes/pendentes
router.get('/pendentes', async (req, res) => {
  const { data, error } = await supabase
    .from('avaliacoes_loja')
    .select('id, nome_cliente, email, nota, comentario, produto_id, criado_em')
    .eq('aprovado', false)
    .order('criado_em', { ascending: false })

  if (error) {
    console.error('[avaliacoes-admin] erro ao listar pendentes:', error.message)
    return res.status(500).json({ erro: 'Falha ao buscar avaliações pendentes' })
  }

  res.json({ avaliacoes: data, total: data.length })
})

// PATCH /api/admin/avaliacoes/:id/aprovar
router.patch('/:id/aprovar', async (req, res) => {
  const { data, error } = await supabase
    .from('avaliacoes_loja')
    .update({ aprovado: true })
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[avaliacoes-admin] erro ao aprovar:', error.message)
    return res.status(500).json({ erro: 'Falha ao aprovar avaliação' })
  }
  if (!data) {
    return res.status(404).json({ erro: 'Avaliação não encontrada' })
  }

  res.json({ sucesso: true })
})

// DELETE /api/admin/avaliacoes/:id
router.delete('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('avaliacoes_loja')
    .delete()
    .eq('id', req.params.id)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('[avaliacoes-admin] erro ao remover:', error.message)
    return res.status(500).json({ erro: 'Falha ao remover avaliação' })
  }
  if (!data) {
    return res.status(404).json({ erro: 'Avaliação não encontrada' })
  }

  res.json({ sucesso: true })
})

export default router
