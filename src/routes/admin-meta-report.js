import { Router } from 'express'
import { runMetaReport as runMetaReportReal } from '../jobs/meta-report.js'
import { metaReportAuthValido } from '../middleware/metaReportAuth.js'

// Disparo manual do relatório Meta Ads — autenticado via API_SECRET_KEY
// estático (ver metaReportAuth.js), fora do JWT/role de usuário comum.
// runMetaReport é injetável só para teste isolado (evita chamar Meta Graph
// API/Google Sheets/WhatsApp de verdade); em produção usa sempre a real.
export function criarAdminMetaReportRouter({ runMetaReport = runMetaReportReal } = {}) {
  const router = Router()

  router.post('/', async (req, res) => {
    if (!metaReportAuthValido(req.headers.authorization)) {
      return res.status(401).json({ erro: 'Não autorizado' })
    }
    try {
      const daysAgo = Number(req.query.daysAgo) || 1
      const resultado = await runMetaReport({ daysAgo })
      res.json({ ok: true, ...resultado })
    } catch (err) {
      const detail = err.response?.data ?? err.message
      console.error('[meta-report manual] Erro:', JSON.stringify(detail))
      res.status(500).json({ erro: err.message, detail })
    }
  })

  return router
}

export default criarAdminMetaReportRouter()
