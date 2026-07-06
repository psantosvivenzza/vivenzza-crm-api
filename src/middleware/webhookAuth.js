import { timingSafeEqual } from 'crypto'

// S1-2: Valida o token enviado pela Evolution API no header x-webhook-token.
// Se EVOLUTION_WEBHOOK_TOKEN não estiver configurado → skip (backward compat).
// Usa timingSafeEqual para evitar timing attacks.
export function webhookAuth(req, res, next) {
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN
  if (!expected) return next()

  const sent = req.headers['x-webhook-token'] ?? ''
  let valid = false
  try {
    const a = Buffer.from(sent, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    valid = a.length === b.length && timingSafeEqual(a, b)
  } catch {
    valid = false
  }

  if (!valid) {
    console.warn('[webhookAuth] token inválido | ip:', req.ip,
      '| x-webhook-token present:', !!req.headers['x-webhook-token'])
    return res.status(401).json({ erro: 'Token de webhook inválido' })
  }

  next()
}
