import https from 'https'

// ─── Token cache ──────────────────────────────────────────────────────────────
// google-ads-api v24 usa gaxios v6 → fetch nativo (undici) para renovar o token,
// o que causa "Premature close" no container Linux do Railway.
// Solução definitiva: substituir toda a lib por chamadas REST diretas com https
// nativo, que não usa undici e funciona corretamente no ambiente Railway.

let _cachedToken = null
let _tokenExpiry  = 0

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

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry - 60_000) return _cachedToken
  const { access_token, expires_in } = await fetchAccessToken()
  _cachedToken = access_token
  _tokenExpiry  = Date.now() + expires_in * 1000
  console.log('[google-ads] access_token renovado, expira em', expires_in, 's')
  return _cachedToken
}

// ─── Google Ads REST API v17 ──────────────────────────────────────────────────
// Executa uma query GAQL e retorna todos os resultados (faz paginação automática).

const GADS_VERSION = 'v24'

export async function gaqlQuery(gaql) {
  const {
    GOOGLE_ADS_CUSTOMER_ID,
    GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    GOOGLE_ADS_DEVELOPER_TOKEN,
  } = process.env

  const customerId    = GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '')
  const loginId       = GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, '')
  const accessToken   = await getAccessToken()
  const path          = `/${GADS_VERSION}/customers/${customerId}/googleAds:search`

  const baseHeaders = {
    'Authorization':  `Bearer ${accessToken}`,
    'developer-token': GOOGLE_ADS_DEVELOPER_TOKEN,
    'Content-Type':   'application/json',
    ...(loginId ? { 'login-customer-id': loginId } : {}),
  }

  const results = []

  const fetchPage = (pageToken) => new Promise((resolve, reject) => {
    const payload = JSON.stringify({ query: gaql, ...(pageToken ? { pageToken } : {}) })

    const req = https.request({
      hostname: 'googleads.googleapis.com',
      path,
      method:   'POST',
      headers:  { ...baseHeaders, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', async () => {
        try {
          const json = JSON.parse(data)
          if (res.statusCode !== 200) {
            const detail = json.error?.message ?? JSON.stringify(json).slice(0, 300)
            return reject(new Error(`Google Ads API ${res.statusCode}: ${detail}`))
          }
          results.push(...(json.results ?? []))
          if (json.nextPageToken) {
            fetchPage(json.nextPageToken).then(resolve).catch(reject)
          } else {
            resolve()
          }
        } catch {
          reject(new Error(`Resposta inválida: ${data.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })

  await fetchPage(null)
  return results
}

// ─── Guard de configuração ────────────────────────────────────────────────────

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
