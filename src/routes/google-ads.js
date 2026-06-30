import { Router } from 'express'
import { getCustomer, googleAdsConfigurado } from '../lib/googleAdsClient.js'

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fromMicros = (v) => (Number(v || 0) / 1_000_000)

// Converte status numérico do enum para string legível
const STATUS_MAP = { 2: 'ENABLED', 3: 'PAUSED', 4: 'REMOVED' }

function normalizeStatus(s) {
  return STATUS_MAP[s] ?? String(s)
}

// ─── Guard: retorna 503 se as variáveis ainda não estão configuradas ──────────

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
// Retorna campanhas ativas/pausadas dos últimos 30 dias.
// Interface idêntica ao /api/admin/campanhas/resumo (campo `fonte: 'google'`)
// para facilitar a fusão no frontend.

router.get('/resumo', async (req, res) => {
  if (requireConfig(res)) return
  try {
    const customer = getCustomer()

    const rows = await customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.cost_micros,
        metrics.impressions,
        metrics.reach_metric_value,
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
      fonte: 'google',
      id: String(r.campaign.id),
      nome: r.campaign.name,
      status: normalizeStatus(r.campaign.status),
      gasto: fromMicros(r.metrics.cost_micros),
      impressoes: Number(r.metrics.impressions || 0),
      alcance: Number(r.metrics.reach_metric_value || 0),
      cliques: Number(r.metrics.clicks || 0),
      ctr: Number(r.metrics.ctr || 0) * 100,       // Google retorna 0–1, normaliza para %
      cpm: fromMicros(r.metrics.average_cpm),
      // Google Ads não tem "conversas iniciadas" nativo — usa conversions genéricas
      // até que uma ação de conversão específica de WhatsApp seja configurada
      conversas: Number(r.metrics.conversions || 0),
      custoConversa: r.metrics.cost_per_conversion
        ? fromMicros(r.metrics.cost_per_conversion)
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
    const customer = getCustomer()

    const rows = await customer.query(`
      SELECT
        segments.date,
        metrics.cost_micros,
        metrics.conversions
      FROM campaign
      WHERE segments.date DURING LAST_30_DAYS
        AND campaign.status != 'REMOVED'
      ORDER BY segments.date ASC
    `)

    // Agrega por dia (a query retorna uma linha por campanha por dia)
    const byDay = {}
    for (const r of rows) {
      const dia = r.segments.date
      if (!byDay[dia]) byDay[dia] = { dia, gasto: 0, conversas: 0 }
      byDay[dia].gasto = parseFloat((byDay[dia].gasto + fromMicros(r.metrics.cost_micros)).toFixed(2))
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
