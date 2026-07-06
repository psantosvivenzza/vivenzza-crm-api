import { createHash } from 'crypto'
import axios from 'axios'

const DATASET_ID = '793319092126866'
const CAPI_URL = `https://graph.facebook.com/v21.0/${DATASET_ID}/events`

function sha256(value) {
  if (!value) return null
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex')
}

// Normaliza para E.164 sem "+" — formato que a CAPI do Meta espera para hashing
function normalizarParaHash(telefone) {
  if (!telefone) return null
  const digits = telefone.replace(/\D/g, '')
  if (!digits) return null
  // Se tem 10-11 dígitos (número local sem DDI) → adiciona 55 (Brasil)
  if (digits.length <= 11) return '55' + digits
  return digits
}

export async function enviarLeadCAPI({ event_id, event_source_url, telefone, email, client_ip, user_agent }) {
  const token = process.env.META_CAPI_TOKEN
  if (!token) {
    console.log('[capi] META_CAPI_TOKEN não configurado — evento Lead não enviado')
    return
  }

  const user_data = {}
  if (client_ip) user_data.client_ip_address = client_ip
  if (user_agent) user_data.client_user_agent = user_agent

  const phoneNorm = normalizarParaHash(telefone)
  if (phoneNorm) user_data.ph = [sha256(phoneNorm)]
  if (email) user_data.em = [sha256(email)]

  const payload = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      event_id: event_id || `lead_server_${Date.now()}`,
      event_source_url: event_source_url || 'https://vivenzza-distribuidores.netlify.app/',
      action_source: 'website',
      user_data,
    }],
    access_token: token,
  }

  // Permite testar no Gerenciador de Eventos sem poluir dados reais
  const testCode = process.env.META_CAPI_TEST_CODE
  if (testCode) payload.test_event_code = testCode

  try {
    const { data } = await axios.post(CAPI_URL, payload)
    console.log('[capi] Lead enviado | event_id:', event_id, '| events_received:', data.events_received)
    return data
  } catch (err) {
    const detail = err.response?.data ?? err.message
    console.error('[capi] erro ao enviar Lead:', JSON.stringify(detail))
  }
}
