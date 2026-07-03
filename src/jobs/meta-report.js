import axios from 'axios'
import { google } from 'googleapis'
import { gaqlQuery, googleAdsConfigurado } from '../lib/googleAdsClient.js'

const {
  META_ACCESS_TOKEN,
  META_AD_ACCOUNT_ID,
  META_GRAPH_VERSION = 'v21.0',
  GOOGLE_SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  EVOLUTION_API_URL,
  EVOLUTION_API_KEY,
  EVOLUTION_INSTANCE,
  WHATSAPP_REPORT_NUMBER,
} = process.env

// ─── Google Sheets ────────────────────────────────────────────────────────────

function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON)
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

async function ensureSheet(sheets, title) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: GOOGLE_SHEETS_ID })
  const exists = spreadsheet.data.sheets.some((s) => s.properties.title === title)
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: GOOGLE_SHEETS_ID,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    })
  }
}

async function writeToSheets(rows, dateLabel) {
  const sheets = getSheetsClient()
  await ensureSheet(sheets, dateLabel)

  const header = [
    'Campanha', 'Status', 'Gasto (R$)', 'Impressões', 'Alcance', 'Freq.',
    'Cliques', 'CTR (%)', 'CPM (R$)', 'CPC (R$)',
    'Conversas iniciadas', 'Custo/conversa (R$)',
    'Conexões msg', 'Custo/conexão (R$)',
  ]

  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_ID,
    range: `${dateLabel}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [header, ...rows] },
  })

  return dateLabel
}

// ─── Meta Ads ─────────────────────────────────────────────────────────────────

async function fetchMetaInsights(dateStart, dateStop) {
  const fields = [
    'campaign_name', 'campaign_id', 'spend', 'impressions', 'reach',
    'frequency', 'clicks', 'ctr', 'cpm', 'cost_per_inline_link_click',
    'actions', 'cost_per_action_type',
  ].join(',')

  const { data } = await axios.get(
    `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_AD_ACCOUNT_ID}/insights`,
    {
      params: {
        fields,
        time_range: JSON.stringify({ since: dateStart, until: dateStop }),
        level: 'campaign',
        limit: 50,
        access_token: META_ACCESS_TOKEN,
      },
    }
  )
  return data.data || []
}

// Busca status atual de cada campanha (insights não traz status de campanhas pausadas)
async function fetchCampaignStatuses(ids) {
  if (!ids.length) return {}
  const fields = 'id,status'
  const map = {}
  await Promise.all(
    ids.map(async (id) => {
      try {
        const { data } = await axios.get(
          `https://graph.facebook.com/${META_GRAPH_VERSION}/${id}`,
          { params: { fields, access_token: META_ACCESS_TOKEN } }
        )
        map[id] = data.status
      } catch {
        map[id] = '?'
      }
    })
  )
  return map
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const fmt = (v, d = 2) => {
  const n = parseFloat(v)
  return isNaN(n) ? '-' : n.toFixed(d)
}

const getAction = (actions, type) =>
  actions?.find((a) => a.action_type === type)?.value ?? '0'

const getCost = (costs, type) =>
  costs?.find((a) => a.action_type === type)?.value ?? null

// ─── Google Ads ────────────────────────────────────────────────────────────────

async function fetchGoogleAdsDaily(dateLabel) {
  if (!googleAdsConfigurado()) return null

  const rows = await gaqlQuery(`
    SELECT
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM campaign
    WHERE segments.date = '${dateLabel}'
      AND campaign.status != 'REMOVED'
  `)

  if (!rows.length) return null

  const fromMicros = (v) => Number(v || 0) / 1_000_000
  const gasto      = rows.reduce((s, r) => s + fromMicros(r.metrics.costMicros),   0)
  const cliques    = rows.reduce((s, r) => s + Number(r.metrics.clicks       || 0), 0)
  const impressoes = rows.reduce((s, r) => s + Number(r.metrics.impressions  || 0), 0)
  const conversoes = rows.reduce((s, r) => s + Number(r.metrics.conversions  || 0), 0)
  const ctr        = impressoes > 0 ? (cliques / impressoes) * 100 : 0
  const custoConv  = conversoes > 0 ? gasto / conversoes : null

  return { gasto, cliques, impressoes, ctr, conversoes, custoConv }
}

function buildGoogleAdsBlock(data, dateLabel) {
  const sep = '━━━━━━━━━━━━━━━━━━━━━'
  const header = `\n${sep}\n📊 *GOOGLE ADS — ${dateLabel}*\n${sep}`

  if (!data) {
    return `${header}\n🔴 Sem campanhas ativas no momento`
  }

  const { gasto, cliques, impressoes, ctr, conversoes, custoConv } = data
  return (
    `${header}\n` +
    `💰 Gasto: R$ ${fmt(gasto)}\n` +
    `👆 Cliques: ${cliques}\n` +
    `📈 Impressões: ${impressoes}\n` +
    `🎯 CTR: ${fmt(ctr)}%\n` +
    `💬 Conversões: ${conversoes}\n` +
    `💵 Custo/Conversão: R$ ${custoConv !== null ? fmt(custoConv) : '-'}`
  )
}

// ─── Mensagem WhatsApp ────────────────────────────────────────────────────────

function buildMessage(insights, statusMap, dateLabel, totalSpend) {
  const linhas = [`📊 *Relatório Meta Ads — ${dateLabel}*\n`]

  for (const c of insights) {
    const status = statusMap[c.campaign_id] || '?'
    const emoji = status === 'ACTIVE' ? '🟢' : '⏸️'
    const conversas = getAction(c.actions, 'onsite_conversion.messaging_conversation_started_7d')
    const custoConv = getCost(c.cost_per_action_type, 'onsite_conversion.messaging_conversation_started_7d')

    linhas.push(
      `${emoji} *${c.campaign_name}*\n` +
      `   Gasto: R$ ${fmt(c.spend)} | CTR: ${fmt(c.ctr)}%\n` +
      `   Conversas: ${conversas}${custoConv ? ` | R$ ${fmt(custoConv)}/conv` : ''}`
    )
  }

  linhas.push(`\n💰 *Total: R$ ${fmt(totalSpend)}*`)
  linhas.push(`📋 Detalhes na planilha → bit.ly/vivenzza-ads`)
  return linhas.join('\n')
}

// ─── WhatsApp via Evolution API ───────────────────────────────────────────────

async function sendWhatsApp(text) {
  if (!EVOLUTION_API_URL || !EVOLUTION_INSTANCE || !WHATSAPP_REPORT_NUMBER) {
    console.warn('[meta-report] WhatsApp não configurado — pulando envio')
    return
  }
  await axios.post(
    `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    { number: WHATSAPP_REPORT_NUMBER, text },
    { headers: { apikey: EVOLUTION_API_KEY } }
  )
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function runMetaReport({ daysAgo = 1 } = {}) {
  // Data alvo em BRT (UTC-3)
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  brt.setDate(brt.getDate() - daysAgo)
  const dateLabel = brt.toISOString().split('T')[0]

  console.log(`[meta-report] Iniciando relatório para ${dateLabel}...`)

  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    throw new Error('META_ACCESS_TOKEN ou META_AD_ACCOUNT_ID não configurados')
  }
  if (!GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_SHEETS_ID) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON ou GOOGLE_SHEETS_ID não configurados')
  }

  const insights = await fetchMetaInsights(dateLabel, dateLabel)

  if (!insights.length) {
    console.log(`[meta-report] Sem dados para ${dateLabel}`)
    return { dateLabel, campanhas: 0 }
  }

  const statusMap = await fetchCampaignStatuses(insights.map((c) => c.campaign_id))
  const totalSpend = insights.reduce((s, c) => s + parseFloat(c.spend || 0), 0)

  // Monta linhas para a planilha
  const rows = insights.map((c) => [
    c.campaign_name,
    statusMap[c.campaign_id] || '-',
    fmt(c.spend),
    c.impressions || '0',
    c.reach || '0',
    fmt(c.frequency),
    c.clicks || '0',
    fmt(c.ctr),
    fmt(c.cpm),
    fmt(c.cost_per_inline_link_click),
    getAction(c.actions, 'onsite_conversion.messaging_conversation_started_7d'),
    fmt(getCost(c.cost_per_action_type, 'onsite_conversion.messaging_conversation_started_7d')),
    getAction(c.actions, 'onsite_conversion.total_messaging_connection'),
    fmt(getCost(c.cost_per_action_type, 'onsite_conversion.total_messaging_connection')),
  ])

  const sheetName = await writeToSheets(rows, dateLabel)
  console.log(`[meta-report] Planilha atualizada: aba "${sheetName}"`)

  let msg = buildMessage(insights, statusMap, dateLabel, totalSpend)

  try {
    const gadsData = await fetchGoogleAdsDaily(dateLabel)
    msg += buildGoogleAdsBlock(gadsData, dateLabel)
  } catch (err) {
    console.error('[meta-report] Google Ads fetch falhou:', err.message)
    msg += buildGoogleAdsBlock(null, dateLabel)
  }

  await sendWhatsApp(msg)
  console.log(`[meta-report] WhatsApp enviado para ${WHATSAPP_REPORT_NUMBER}`)

  const resultado = { dateLabel, campanhas: insights.length, totalSpend: fmt(totalSpend), sheetName }
  console.log('[meta-report] Concluído:', resultado)
  return resultado
}
