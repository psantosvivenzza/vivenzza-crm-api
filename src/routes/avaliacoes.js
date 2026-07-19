import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { supabase } from '../lib/supabase.js'

const router = Router()

// 1 avaliação por IP a cada 10 min — evita spam no formulário público sem
// exigir cadastro/captcha.
const avaliacaoLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 1,
  message: { erro: 'Você já enviou uma avaliação recentemente. Tente novamente em alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// POST /api/avaliacoes — formulário público, entra em fila de moderação.
router.post('/', avaliacaoLimit, async (req, res) => {
  const { nome, nota, comentario, produto_id, email } = req.body

  if (!nome?.trim()) {
    return res.status(400).json({ erro: 'Campo "nome" é obrigatório' })
  }
  if (nome.length > 100) {
    return res.status(400).json({ erro: 'Campo "nome" excede 100 caracteres' })
  }
  const notaNum = Number(nota)
  if (!Number.isInteger(notaNum) || notaNum < 1 || notaNum > 5) {
    return res.status(400).json({ erro: 'Campo "nota" deve ser um número inteiro entre 1 e 5' })
  }
  if (!comentario?.trim() || comentario.trim().length < 10) {
    return res.status(400).json({ erro: 'Campo "comentario" deve ter pelo menos 10 caracteres' })
  }
  if (comentario.length > 2000) {
    return res.status(400).json({ erro: 'Campo "comentario" excede 2000 caracteres' })
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ erro: 'Campo "email" inválido' })
  }

  const { data, error } = await supabase
    .from('avaliacoes_loja')
    .insert({
      nome_cliente: nome.trim(),
      email: email?.trim() || null,
      nota: notaNum,
      comentario: comentario.trim(),
      produto_id: produto_id ? String(produto_id) : null,
      aprovado: false,
    })
    .select('id, criado_em')
    .single()

  if (error) {
    console.error('[avaliacoes] erro ao salvar:', error.message)
    return res.status(500).json({ erro: 'Falha ao salvar avaliação' })
  }

  res.status(201).json({ sucesso: true, id: data.id, mensagem: 'Avaliação recebida — entra no ar após moderação.' })
})

// GET /api/avaliacoes — só avaliações aprovadas. ?produto_id= filtra por produto.
router.get('/', async (req, res) => {
  const { produto_id } = req.query

  let query = supabase
    .from('avaliacoes_loja')
    .select('id, nome_cliente, nota, comentario, produto_id, criado_em')
    .eq('aprovado', true)
    .order('criado_em', { ascending: false })
    .limit(50)

  if (produto_id) query = query.eq('produto_id', String(produto_id))

  const { data, error } = await query

  if (error) {
    console.error('[avaliacoes] erro ao listar:', error.message)
    return res.status(500).json({ erro: 'Falha ao buscar avaliações' })
  }

  const total = data.length
  const media = total > 0 ? data.reduce((s, a) => s + a.nota, 0) / total : 0

  res.json({
    avaliacoes: data,
    media: Number(media.toFixed(2)),
    total,
  })
})

export default router
