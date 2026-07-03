import { Router } from 'express'
import { gaqlQuery, googleAdsConfigurado } from '../lib/googleAdsClient.js'

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────
// REST API retorna int64 como string e valores monetários em micros.

const fromMicros = (v) => Number(v || 0) / 1_000_000

// ─── Guard ────────────────────────────────────────────────────────────────────

function requireConfig(res) {
  if (!googleAdsConfigurado()) {
    res.status(503).json({
      erro: 'Google Ads ainda não configurado.',
      pendente: [
        'GOOGLE_ADS_CLIENT_ID',
        'GOOGLE_ADS_CLIENT_SECRET',
        'GOOGLE_ADS_DEVELOPER_TOKEN',
        'GOOGLE_ADS_CUSTOMER_ID',
        'GOOGLE_ADS_REFRESH_TOKEN',
      ].filter((k) => !process.env[k]),
    })
    return true
  }
  return false
}

// ─── GET /api/admin/google-ads/resumo ────────────────────────────────────────
// Interface idêntica ao /api/admin/campanhas/resumo (campo `fonte: 'google'`).
// REST API v17: campos int64 chegam como string, status como enum string.

router.get('/resumo', async (req, res) => {
  if (requireConfig(res)) return
  try {
    const rows = await gaqlQuery(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.cost_micros,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.average_cpm,
        metrics.conversions,
        metrics.cost_per_conversion
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign.status != 'REMOVED'
    `)

    const campanhas = rows.map((r) => ({
      fonte:          'google',
      id:             String(r.campaign.id),
      nome:           r.campaign.name,
      status:         r.campaign.status,                              // já é string: "ENABLED" | "PAUSED"
      gasto:          fromMicros(r.metrics.costMicros),
      impressoes:     Number(r.metrics.impressions  || 0),
      alcance:        0,                                              // não disponível em campanhas padrão
      cliques:        Number(r.metrics.clicks       || 0),
      ctr:            Number(r.metrics.ctr          || 0) * 100,     // API retorna 0–1, converte para %
      cpm:            fromMicros(r.metrics.averageCpm),
      conversas:      Number(r.metrics.conversions  || 0),
      custoConversa:  r.metrics.costPerConversion
        ? fromMicros(r.metrics.costPerConversion)
        : null,
    }))

    res.json({ campanhas, periodo: { fonte: 'google', dias: 30 } })
  } catch (err) {
    console.error('[google-ads/resumo]', err.message)
    res.status(500).json({ erro: err.message })
  }
})

// ─── GET /api/admin/google-ads/historico ─────────────────────────────────────
// Série temporal diária — mesma interface do /api/admin/campanhas/historico.

router.get('/historico', async (req, res) => {
  if (requireConfig(res)) return
  try {
    const rows = await gaqlQuery(`
      SELECT
        segments.date,
        metrics.cost_micros,
        metrics.conversions
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign.status != 'REMOVED'
      ORDER BY segments.date ASC
    `)

    const byDay = {}
    for (const r of rows) {
      const dia = r.segments.date
      if (!byDay[dia]) byDay[dia] = { dia, gasto: 0, conversas: 0 }
      byDay[dia].gasto      = parseFloat((byDay[dia].gasto + fromMicros(r.metrics.costMicros)).toFixed(2))
      byDay[dia].conversas += Number(r.metrics.conversions || 0)
    }

    const serie = Object.values(byDay).sort((a, b) => a.dia.localeCompare(b.dia))
    res.json({ serie, periodo: { fonte: 'google', dias: 30 } })
  } catch (err) {
    console.error('[google-ads/historico]', err.message)
    res.status(500).json({ erro: err.message })
  }
})

export default router
