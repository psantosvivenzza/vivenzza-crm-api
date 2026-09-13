import { timingSafeEqual } from 'crypto'

// POST /api/admin/meta-report (disparo manual do relatório Meta Ads) era a
// única rota com secret estático fora do padrão usado no resto do repo —
// webhookAuth.js e aiWorkerAuth.js já usam timingSafeEqual e recusam
// (fail-closed) quando o segredo não está configurado; esta rota comparava
// direto com `!==` sem checar se API_SECRET_KEY existia, então
// API_SECRET_KEY ausente virava `Bearer undefined`, e um chamador que
// mandasse esse valor literal era aceito como autorizado.
export function metaReportAuthValido(authorizationHeader) {
  const secret = process.env.API_SECRET_KEY
  if (!secret) return false

  const esperado = `Bearer ${secret}`
  const recebido = authorizationHeader ?? ''
  try {
    const a = Buffer.from(recebido, 'utf8')
    const b = Buffer.from(esperado, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}
