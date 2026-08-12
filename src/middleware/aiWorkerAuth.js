import { timingSafeEqual } from 'crypto'

// Token de escopo estreito, dedicado ao worker local de IA — nunca reaproveita
// EVOLUTION_WEBHOOK_TOKEN, Supabase service key ou JWT de usuário comum.
//
// Diferente de webhookAuth.js (que faz skip se o token não estiver
// configurado, por compat com um webhook legado): este middleware é
// FAIL-CLOSED — sem AI_WORKER_TOKEN configurado, TODA requisição é
// recusada, nunca abre acidentalmente um endpoint que lê/escreve sugestões
// de IA e mensagens de cliente.
export function aiWorkerAuth(req, res, next) {
  const expected = process.env.AI_WORKER_TOKEN
  if (!expected) {
    console.warn('[aiWorkerAuth] AI_WORKER_TOKEN não configurado — recusando (fail-closed)')
    return res.status(503).json({ erro: 'AI worker não configurado' })
  }

  const sent = req.headers['x-ai-worker-token'] ?? ''
  let valid = false
  try {
    const a = Buffer.from(sent, 'utf8')
    const b = Buffer.from(expected, 'utf8')
    valid = a.length === b.length && timingSafeEqual(a, b)
  } catch {
    valid = false
  }

  if (!valid) {
    console.warn('[aiWorkerAuth] token inválido | ip:', req.ip, '| x-ai-worker-token presente:', !!req.headers['x-ai-worker-token'])
    return res.status(401).json({ erro: 'Token de worker inválido' })
  }

  next()
}
