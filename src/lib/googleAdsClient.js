import https from 'https'
import { GoogleAdsApi } from 'google-ads-api'

// ─── Token cache ──────────────────────────────────────────────────────────────
// gaxios v6 (usado pelo google-ads-api) usa o fetch nativo (undici) para renovar
// o token OAuth2, o que causa "Premature close" no ambiente Railway (Linux).
// Solução: renovar o access_token manualmente via https nativo, que não usa undici,
// e passar access_token direto ao Customer() — bypassando o fluxo gaxios/OAuth2.

let _cachedToken = null
let _tokenExpiry = 0   // timestamp ms

function fetchAccessToken() {
  const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN } = process.env
  const body = new URLSearchParams({
    client_id:     GOOGLE_ADS_CLIENT_ID,
    client_secret: GOOGLE_ADS_CLIENT_SECRET,
    refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
    grant_type:    'refresh_token',
  }).toString()

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          if (json.access_token) resolve(json)
          else reject(new Error(`OAuth2: ${json.error} — ${json.error_description ?? data}`))
        } catch {
          reject(new Error(`OAuth2: resposta inválida — ${data.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Retorna access_token válido; renova se expirar em < 60 s.
async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) {
    return _cachedToken
  }
  const { access_token, expires_in } = await fetchAccessToken()
  _cachedToken  = access_token
  _tokenExpiry  = Date.now() + expires_in * 1000
  console.log('[google-ads] access_token renovado, expira em', expires_in, 's')
  return _cachedToken
}

// ─── Singleton do cliente Google Ads ─────────────────────────────────────────

let _api = null

function getApi() {
  if (!_api) {
    const { GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN } = process.env
    if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_DEVELOPER_TOKEN) {
      throw new Error(
        'Google Ads não configurado. Defina GOOGLE_ADS_CLIENT_ID, ' +
        'GOOGLE_ADS_CLIENT_SECRET e GOOGLE_ADS_DEVELOPER_TOKEN.'
      )
    }
    _api = new GoogleAdsApi({
      client_id:       GOOGLE_ADS_CLIENT_ID,
      client_secret:   GOOGLE_ADS_CLIENT_SECRET,
      developer_token: GOOGLE_ADS_DEVELOPER_TOKEN,
    })
  }
  return _api
}

/**
 * Retorna um Customer autenticado pronto para queries GAQL.
 * Usa access_token obtido via https nativo (não gaxios/undici).
 */
export async function getCustomer() {
  const { GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_LOGIN_CUSTOMER_ID } = process.env

  if (!GOOGLE_ADS_CUSTOMER_ID) {
    throw new Error('Google Ads não configurado. Defina GOOGLE_ADS_CUSTOMER_ID.')
  }

  const access_token = await getAccessToken()

  return getApi().Customer({
    customer_id: GOOGLE_ADS_CUSTOMER_ID,
    ...(GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { login_customer_id: GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
    access_token,
  })
}

/**
 * Retorna true se todas as variáveis obrigatórias estão definidas.
 */
export function googleAdsConfigurado() {
  const {
    GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CUSTOMER_ID,
    GOOGLE_ADS_REFRESH_TOKEN,
  } = process.env
  return !!(
    GOOGLE_ADS_CLIENT_ID && GOOGLE_ADS_CLIENT_SECRET &&
    GOOGLE_ADS_DEVELOPER_TOKEN && GOOGLE_ADS_CUSTOMER_ID &&
    GOOGLE_ADS_REFRESH_TOKEN
  )
}
