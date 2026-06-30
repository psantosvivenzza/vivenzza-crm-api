import { GoogleAdsApi } from 'google-ads-api'

// ─── Singleton do cliente Google Ads ─────────────────────────────────────────
// Lazy-initialized para não explodir na inicialização caso as vars não existam.
// Usar getCustomer() em vez de importar o cliente diretamente.

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
      client_id: GOOGLE_ADS_CLIENT_ID,
      client_secret: GOOGLE_ADS_CLIENT_SECRET,
      developer_token: GOOGLE_ADS_DEVELOPER_TOKEN,
    })
  }
  return _api
}

/**
 * Retorna um Customer autenticado pronto para queries GAQL.
 * customer_id  → conta de anúncios (ex: "123-456-7890")
 * login_customer_id → conta MCC (opcional; obrigatório se acessar via MCC)
 */
export function getCustomer() {
  const {
    GOOGLE_ADS_CUSTOMER_ID,
    GOOGLE_ADS_LOGIN_CUSTOMER_ID,
    GOOGLE_ADS_REFRESH_TOKEN,
  } = process.env

  if (!GOOGLE_ADS_CUSTOMER_ID || !GOOGLE_ADS_REFRESH_TOKEN) {
    throw new Error(
      'Google Ads não configurado. Defina GOOGLE_ADS_CUSTOMER_ID e GOOGLE_ADS_REFRESH_TOKEN.'
    )
  }

  return getApi().Customer({
    customer_id: GOOGLE_ADS_CUSTOMER_ID,
    ...(GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { login_customer_id: GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}),
    refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
  })
}

/**
 * Retorna true se todas as variáveis obrigatórias estão definidas.
 * Útil para exibir estado "não configurado" no frontend sem lançar erro.
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
