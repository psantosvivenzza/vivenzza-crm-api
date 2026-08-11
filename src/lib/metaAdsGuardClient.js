// Cliente mínimo da Graph API (Marketing API) para o hard-cap de spend do Meta
// Ads. Mesmo padrão de acesso (token em querystring, versão configurável) já
// usado em src/jobs/meta-report.js e em meta-ads/src/lib/metaClient.js (projeto
// irmão) — reescrito aqui porque os dois projetos são pacotes npm separados
// (não dá para importar um do outro) e este processo (vivenzza-crm-api) já tem
// META_ACCESS_TOKEN/META_AD_ACCOUNT_ID configurados no Railway (usados pelo
// meta-report.js), então não precisa de nenhum segredo novo.
import axios from 'axios'

const { META_ACCESS_TOKEN, META_AD_ACCOUNT_ID, META_GRAPH_VERSION = 'v21.0' } = process.env

function assertConfigurado() {
  if (!META_ACCESS_TOKEN || !META_AD_ACCOUNT_ID) {
    throw new Error('META_ACCESS_TOKEN/META_AD_ACCOUNT_ID não configurados no ambiente')
  }
}

const metaApi = axios.create({
  baseURL: `https://graph.facebook.com/${META_GRAPH_VERSION}`,
  timeout: 20000,
})
metaApi.interceptors.request.use((config) => {
  config.params = { access_token: META_ACCESS_TOKEN, ...config.params }
  return config
})
metaApi.interceptors.response.use(
  (res) => res,
  (err) => {
    const metaErro = err.response?.data?.error
    if (metaErro) {
      return Promise.reject(new Error(`${metaErro.message} (code ${metaErro.code}${metaErro.error_subcode ? `/${metaErro.error_subcode}` : ''})`))
    }
    return Promise.reject(err)
  }
)

// Cacheado em módulo — timezone da conta não muda em runtime, evita 1 chamada
// extra por tick do guard.
let timezoneCache = null

export async function obterTimezoneConta() {
  assertConfigurado()
  if (timezoneCache) return timezoneCache
  const { data } = await metaApi.get(`/${META_AD_ACCOUNT_ID}`, { params: { fields: 'timezone_name' } })
  timezoneCache = data.timezone_name
  return timezoneCache
}

// Spend real do dia corrente NO TIMEZONE DA CONTA (date_preset='today' é
// resolvido pelo Meta usando o timezone da própria conta, não UTC nem o
// timezone do servidor) — nível account, uma linha só.
export async function lerSpendHoje() {
  assertConfigurado()
  const { data } = await metaApi.get(`/${META_AD_ACCOUNT_ID}/insights`, {
    params: { fields: 'spend', level: 'account', date_preset: 'today' },
  })
  const linha = data.data?.[0]
  return linha ? parseFloat(linha.spend || 0) : 0
}

export async function listarCampanhasAtivas() {
  assertConfigurado()
  const { data } = await metaApi.get(`/${META_AD_ACCOUNT_ID}/campaigns`, {
    params: { fields: 'id,name,effective_status', effective_status: JSON.stringify(['ACTIVE']), limit: 200 },
  })
  return data.data || []
}

export async function obterStatusCampanha(campaignId) {
  assertConfigurado()
  const { data } = await metaApi.get(`/${campaignId}`, { params: { fields: 'id,name,effective_status' } })
  return data
}

export async function pausarCampanha(campaignId) {
  assertConfigurado()
  await metaApi.post(`/${campaignId}`, null, { params: { status: 'PAUSED' } })
}

export async function reativarCampanha(campaignId) {
  assertConfigurado()
  await metaApi.post(`/${campaignId}`, null, { params: { status: 'ACTIVE' } })
}
