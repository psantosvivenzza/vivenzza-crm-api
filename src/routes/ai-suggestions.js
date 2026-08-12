import { Router } from 'express'
import { listarSugestoes } from '../lib/collection/ai/shadowSuggestions.js'

const router = Router()

// GET /api/ai-suggestions?contaId=...&limit=... — read-only. Mostra as
// sugestões da IA (shadow — nenhuma foi enviada de verdade) pro operador
// revisar no ERP. Sem contaId, lista as mais recentes de qualquer título.
router.get('/', async (req, res) => {
  try {
    const { contaId, limit } = req.query
    const sugestoes = await listarSugestoes({
      contasFinanceirasId: contaId || undefined,
      limit: limit ? Number(limit) : undefined,
    })
    res.json({ data: sugestoes })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
