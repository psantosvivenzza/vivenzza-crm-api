import { Router } from 'express'
import { listarSugestoes, buscarSugestao, registrarFeedback } from '../lib/collection/ai/shadowSuggestions.js'

const router = Router()

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

// POST /api/ai-suggestions/:id/feedback — feedback supervisionado
// (approved/edited/discarded). NUNCA envia WhatsApp, nunca cria cobrança,
// nunca altera contas_financeiras/collection_promises — só registra a
// decisão do operador sobre a sugestão. suggested_reply (original da IA)
// nunca é sobrescrito; em "edited" o texto final fica em
// final_reply_operator, separado.
router.post('/:id/feedback', async (req, res) => {
  try {
    const sugestao = await buscarSugestao(req.params.id)
    if (!sugestao) return res.status(404).json({ erro: 'Sugestão não encontrada' })

    const { action, final_reply } = req.body || {}
    if (!['approved', 'edited', 'discarded'].includes(action)) {
      return res.status(400).json({ erro: 'action deve ser "approved", "edited" ou "discarded"' })
    }
    if (action === 'edited' && !(typeof final_reply === 'string' && final_reply.trim().length > 0)) {
      return res.status(400).json({ erro: 'final_reply é obrigatório e não pode ser vazio para action="edited"' })
    }

    // req.user.id pode ser 'api-user' (compat API_SECRET_KEY, não é uuid) —
    // feedback_by é FK pra usuarios(id); só grava quando é um uuid de
    // verdade, nunca tenta inserir um valor que quebraria a constraint.
    const feedbackBy = UUID_REGEX.test(req.user?.id ?? '') ? req.user.id : null

    const atualizado = await registrarFeedback(req.params.id, { action, finalReply: final_reply, feedbackBy })
    res.json({ data: atualizado })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
