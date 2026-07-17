import { Router } from 'express'
import { timingSafeEqual } from 'crypto'
import axios from 'axios'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const DESTINO_FIXO = '5551981874736'

function tokenValido(recebido) {
  const esperado = process.env.ALERT_WEBHOOK_TOKEN
  if (!esperado) return false
  try {
    const a = Buffer.from(recebido ?? '', 'utf8')
    const b = Buffer.from(esperado, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// POST /api/public/alerta-whatsapp — canal restrito para rotinas automatizadas
// mandarem alerta por WhatsApp. Não usa EVOLUTION_API_KEY nem API_SECRET_KEY —
// só um token dedicado (ALERT_WEBHOOK_TOKEN), e o destino é sempre o mesmo
// número fixo (não aceita "number" do corpo), pra limitar o raio de dano caso
// esse token vaze de alguma automação externa.
router.post('/', async (req, res) => {
  const token = req.headers['x-alert-token']
  if (!tokenValido(token)) {
    return res.status(401).json({ erro: 'Token de alerta inválido' })
  }

  const { mensagem } = req.body
  if (!mensagem?.trim()) {
    return res.status(400).json({ erro: 'Campo "mensagem" é obrigatório' })
  }
  if (mensagem.length > 2000) {
    return res.status(400).json({ erro: 'Mensagem excede 2000 caracteres' })
  }

  try {
    const { data } = await axios.post(
      `${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      { number: DESTINO_FIXO, text: mensagem },
      { headers: { apikey: EVOLUTION_KEY }, timeout: 20000 }
    )
    res.json({ sucesso: true, evolution_id: data?.key?.id ?? null })
  } catch (err) {
    const status = err.response?.status ?? 502
    const detalhe = err.response?.data?.message ?? err.message
    console.error('[alerta-whatsapp] erro ao enviar:', detalhe)
    res.status(status).json({ erro: 'Falha ao enviar WhatsApp', detalhe })
  }
})

export default router
