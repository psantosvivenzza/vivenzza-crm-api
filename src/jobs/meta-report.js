import axios from 'axios'
import { google } from 'googleapis'

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

  const msg = buildMessage(insights, statusMap, dateLabel, totalSpend)
  await sendWhatsApp(msg)
  console.log(`[meta-report] WhatsApp enviado para ${WHATSAPP_REPORT_NUMBER}`)

  const resultado = { dateLabel, campanhas: insights.length, totalSpend: fmt(totalSpend), sheetName }
  console.log('[meta-report] Concluído:', resultado)
  return resultado
}
