import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { metaResults, normalizeGoogleCampaign, readMetadata } from '../../../src/lib/campaignMetrics.js'

const handlers = {}
let metaRows = [], googleRows = [], failPrevious = false, paginationLoop = false, metaRequests = 0
registerHooks({
  resolve(specifier, context, next) {
    let source
    if (specifier === 'express') source = 'export const Router=()=>({get:(path,fn)=>{globalThis.__campaignHandlers[path]=fn}})'
    if (specifier === 'axios') source = 'export default {get:(...args)=>globalThis.__campaignGet(...args)}'
    if (specifier.endsWith('/googleAdsClient.js')) source = 'export const googleAdsConfigurado=()=>true;export const gaqlQuery=()=>globalThis.__googleRows()'
    return source ? { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true } : next(specifier, context)
  },
})
globalThis.__campaignHandlers = handlers
globalThis.__googleRows = () => googleRows
globalThis.__campaignGet = async (_url, config) => {
  metaRequests++
  if (config?.params?.fields === 'id,status') return { data: { status: 'ACTIVE' } }
  if (failPrevious && !config?.params?.time_increment && globalThis.__insightCalls++ > 0) throw new Error('synthetic previous failure')
  return { data: { data: metaRows, ...(paginationLoop ? { paging: { next: 'https://synthetic.invalid/next' } } : {}) } }
}
process.env.META_ACCESS_TOKEN = 'synthetic-token'
process.env.META_AD_ACCOUNT_ID = 'synthetic-account'
async function request(provider, path) {
  for (const key of Object.keys(handlers)) delete handlers[key]
  await import(`../../../src/routes/${provider}.js?test=${Math.random()}`)
  let body, status = 200
  const res = { json: (data) => { body = data }, status: (code) => { status = code; return res } }
  await handlers[path]({}, res)
  Object.defineProperty(body, '__testStatus', { value: status })
  return body
}
test('Google preserva conversões fracionárias, zero e indisponibilidade de conversas', () => {
  const r = normalizeGoogleCampaign({ campaign: { id: '1' }, metrics: { conversions: '2.5', costMicros: '12000000', costPerConversion: '4800000' } })
  assert.equal(r.resultados, 2.5); assert.equal(r.tipoResultado, 'conversao')
  assert.equal(r.conversas, null); assert.equal(r.custoConversa, null); assert.equal(r.custoResultado, 4.8)
  assert.equal(normalizeGoogleCampaign({ campaign: { id: '2' }, metrics: { conversions: '0', costPerConversion: '0' } }).custoResultado, null)
})
test('Meta não soma aliases sobrepostos nem mistura famílias', () => {
  const r = metaResults([{ action_type: 'lead', value: '3' }, { action_type: 'offsite_conversion.fb_pixel_lead', value: '3' }, { action_type: 'purchase', value: '1' }])
  assert.deepEqual(r.metricas, { conversa: 0, lead: 3, compra: 1 })
  assert.equal(r.tipoResultado, 'indeterminado'); assert.equal(r.resultados, null)
})
test('Metadados não inventam atualização, moeda, fuso ou atribuição comprovada', () => {
  const r = readMetadata(new Date('2026-10-15T12:00:00Z'))
  assert.equal(r.consultadoEm, '2026-10-15T12:00:00.000Z'); assert.equal(r.atualizadoEm, null)
  assert.equal(r.moeda, null); assert.equal(r.fusoConta, null)
})
test('Rota Google resumo não devolve conversões como conversas', async () => {
  googleRows = [{ campaign: { id: 'g1', name: 'Sintética', status: 'ENABLED' }, metrics: { conversions: '2.5' } }]
  const r = await request('google-ads', '/resumo')
  assert.equal(r.campanhas[0].conversas, null); assert.equal(r.campanhas[0].resultados, 2.5)
  assert.ok(r.dados.consultadoEm); assert.equal(r.dados.atualizadoEm, null)
})
test('Rota Google histórico separa conversões e conversas', async () => {
  googleRows = [{ segments: { date: '2026-10-14' }, metrics: { costMicros: '1000000', conversions: '1.5' } }]
  const r = await request('google-ads', '/historico')
  assert.equal(r.serie[0].conversas, null); assert.equal(r.serie[0].conversoes, 1.5)
})
test('Rota Meta não infere compra a partir do nome Lookalike', async () => {
  metaRows = [{ campaign_id: 'm1', campaign_name: 'Lookalike sintética', spend: '10', actions: [{ action_type: 'lead', value: '2' }] }]
  const r = await request('campanhas', '/resumo')
  assert.equal(r.campanhas[0].tipoResultado, 'lead'); assert.equal(r.campanhas[0].resultados, 2)
  assert.equal(r.campanhas[0].metricas.lead, 2); assert.equal(r.dados.atualizadoEm, null)
})
test('Rota Meta não soma famílias diferentes no histórico', async () => {
  metaRows = [{ campaign_id: 'm2', date_start: '2026-10-14', actions: [{ action_type: 'lead', value: '2' }, { action_type: 'purchase', value: '1' }] }]
  const r = await request('campanhas', '/historico')
  assert.deepEqual(r.serie[0].metricas, { conversa: 0, lead: 2, compra: 1 }); assert.equal(r.serie[0].resultados, null)
})
test('Falha do período anterior é indisponibilidade, não lista vazia válida', async () => {
  globalThis.__insightCalls = 0; failPrevious = true
  try { const r = await request('campanhas', '/resumo'); assert.equal(r.dados.comparacaoDisponivel, false) }
  finally { failPrevious = false }
})
test('Meta sem configuração retorna código explícito e não consulta provedor', async () => {
  const before = metaRequests
  delete process.env.META_ACCESS_TOKEN
  try {
    const r = await request('campanhas', '/resumo')
    assert.equal(r.codigo, 'CAMPANHAS_NAO_CONFIGURADO'); assert.equal(r.__testStatus, 503); assert.equal(metaRequests, before)
  }
  finally { process.env.META_ACCESS_TOKEN = 'synthetic-token' }
})
test('Limite de paginação Meta não retorna dados truncados como sucesso', async () => {
  paginationLoop = true
  try {
    const r = await request('campanhas', '/historico')
    assert.match(r.erro, /incompleta/); assert.equal(r.serie, undefined); assert.equal(r.__testStatus, 500)
  } finally { paginationLoop = false }
})
test('Meta zero observado permanece zero por família, sem adivinhar objetivo', () => {
  assert.deepEqual(metaResults([]), { metricas: { conversa: 0, lead: 0, compra: 0 }, tipoResultado: 'indeterminado', resultados: null })
})
