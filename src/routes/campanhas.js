import { Router } from 'express'
import axios from 'axios'

const router = Router()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dateRange(days) {
  const end = new Date()
  const start = new Date()
  start.setDate(start.getDate() - days)
  return {
    since: start.toISOString().split('T')[0],
    until: end.toISOString().split('T')[0],
  }
}

const getAction = (actions, type) =>
  parseFloat(actions?.find((a) => a.action_type === type)?.value || 0)

const getCost = (costs, type) => {
  const v = costs?.find((a) => a.action_type === type)?.value
  return v != null ? parseFloat(v) : null
}

// Resultado correto por tipo de campanha. Antes tudo era lido como "conversa iniciada",
// o que distorcia Landing (leads de formulário) e Lookalike (compras).
const LEAD_TYPES = ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped']
const PURCHASE_TYPES = ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']
const CONVERSA_TYPE = 'onsite_conversion.messaging_conversation_started_7d'

// Os tipos se sobrepõem (mesmo evento sob nomes diferentes): pega o maior, nunca soma.
const maxAction = (actions, types) =>
  Math.max(0, ...types.map((t) => getAction(actions, t)))

function tipoResultado(nome = '') {
  if (/landing|formul|lead/i.test(nome)) return 'lead'
  if (/lookalike|compra|venda|cat[aá]logo|shopping/i.test(nome)) return 'compra'
  return 'conversa'
}

function resultadoCampanha(c) {
  let tipo = tipoResultado(c.campaign_name)
  let qtd = tipo === 'lead' ? maxAction(c.actions, LEAD_TYPES)
    : tipo === 'compra' ? maxAction(c.actions, PURCHASE_TYPES)
    : getAction(c.actions, CONVERSA_TYPE)
  // Se o tipo esperado não registrou nada mas há conversas, mostra conversas.
  if (qtd === 0 && tipo !== 'conversa') {
    const conv = getAction(c.actions, CONVERSA_TYPE)
    if (conv > 0) { tipo = 'conversa'; qtd = conv }
  }
  return { tipo, qtd }
}

// ─── Meta provider ────────────────────────────────────────────────────────────
// Estruturado como módulo isolado para facilitar adição de Google Ads no futuro:
// basta criar um googleAdsProvider com a mesma interface e combinar em cada rota.

const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v21.0'

async function metaFetchInsights(since, until, timeIncrement = null) {
  const { META_ACCESS_TOKEN, META_AD_ACCOUNT_ID } = process.env
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    throw new Error('META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID não configurados')
  }

  const fields = [
    'campaign_name', 'campaign_id', 'spend', 'impressions', 'reach',
    'frequency', 'clicks', 'ctr', 'cpm', 'actions', 'cost_per_action_type',
    'date_start', 'date_stop',
  ].join(',')

  const params = {
    fields,
    time_range: JSON.stringify({ since, until }),
    level: 'campaign',
    limit: 50,
    access_token: META_ACCESS_TOKEN,
  }
  if (timeIncrement) params.time_increment = timeIncrement

  // Pagina até o fim: com time_increment=1 (campanha x dia) o limite de 50 linhas
  // truncava a série (o gráfico parava em 13/09 num período de 30 dias).
  let url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_AD_ACCOUNT_ID}/insights`
  let reqParams = params
  let rows = []
  for (let i = 0; i < 40; i++) {
    const { data } = await axios.get(url, { params: reqParams })
    rows = rows.concat(data.data || [])
    if (!data.paging?.next) break
    url = data.paging.next
    reqParams = undefined
  }
  return rows
}

async function metaFetchStatuses(ids) {
  const { META_ACCESS_TOKEN } = process.env
  const map = {}
  await Promise.all(ids.map(async (id) => {
    try {
      const { data } = await axios.get(
        `https://graph.facebook.com/${META_GRAPH_VERSION}/${id}`,
        { params: { fields: 'id,status', access_token: META_ACCESS_TOKEN } }
      )
      map[id] = data.status
    } catch {
      map[id] = 'UNKNOWN'
    }
  }))
  return map
}

function metaNormalizeResumo(insights, statusMap) {
  return insights.map((c) => ({
    fonte: 'meta',
    id: c.campaign_id,
    nome: c.campaign_name,
    status: statusMap[c.campaign_id] || 'UNKNOWN',
    gasto: parseFloat(c.spend || 0),
    impressoes: parseInt(c.impressions || 0),
    alcance: parseInt(c.reach || 0),
    frequencia: parseFloat(c.frequency || 0),
    cliques: parseInt(c.clicks || 0),
    ctr: parseFloat(c.ctr || 0),
    cpm: parseFloat(c.cpm || 0),
    conversas: getAction(c.actions, CONVERSA_TYPE),
    custoConversa: getCost(c.cost_per_action_type, CONVERSA_TYPE),
    ...(() => {
      const r = resultadoCampanha(c)
      const gasto = parseFloat(c.spend || 0)
      return {
        tipoResultado: r.tipo,
        resultados: r.qtd,
        custoResultado: r.qtd > 0 ? parseFloat((gasto / r.qtd).toFixed(2)) : null,
      }
    })(),
  }))
}

function metaNormalizeHistorico(insights) {
  const byDay = {}
  for (const c of insights) {
    const dia = c.date_start
    if (!byDay[dia]) byDay[dia] = { dia, gasto: 0, conversas: 0, resultados: 0 }
    byDay[dia].gasto = parseFloat((byDay[dia].gasto + parseFloat(c.spend || 0)).toFixed(2))
    byDay[dia].conversas += getAction(c.actions, CONVERSA_TYPE)
    byDay[dia].resultados += resultadoCampanha(c).qtd
  }
  return Object.values(byDay).sort((a, b) => a.dia.localeCompare(b.dia))
}

// ─── Rotas ────────────────────────────────────────────────────────────────────

// GET /api/admin/campanhas/resumo
router.get('/resumo', async (req, res) => {
  try {
    const { since, until } = dateRange(30)
    const insights = await metaFetchInsights(since, until)

    const ids = [...new Set(insights.map((c) => c.campaign_id))]
    const statusMap = await metaFetchStatuses(ids)

    const campanhas = metaNormalizeResumo(insights, statusMap)

    // Período anterior (30 dias antes do período atual) para comparação de cards
    const prevEnd = new Date(since)
    prevEnd.setDate(prevEnd.getDate() - 1)
    const prevStart = new Date(prevEnd)
    prevStart.setDate(prevStart.getDate() - 29)

    let prevInsights = []
    try {
      prevInsights = await metaFetchInsights(
        prevStart.toISOString().split('T')[0],
        prevEnd.toISOString().split('T')[0]
      )
    } catch { /* período anterior é melhor-esforço */ }

    const prevCampanhas = metaNormalizeResumo(prevInsights, {})

    res.json({ campanhas, prevCampanhas, periodo: { since, until } })
  } catch (err) {
    console.error('[campanhas/resumo]', err.response?.data ?? err.message)
    res.status(500).json({ erro: err.message, detail: err.response?.data })
  }
})

// GET /api/admin/campanhas/historico
router.get('/historico', async (req, res) => {
  try {
    const { since, until } = dateRange(30)
    const insights = await metaFetchInsights(since, until, 1)
    const serie = metaNormalizeHistorico(insights)
    res.json({ serie, periodo: { since, until } })
  } catch (err) {
    console.error('[campanhas/historico]', err.response?.data ?? err.message)
    res.status(500).json({ erro: err.message, detail: err.response?.data })
  }
})

export default router
