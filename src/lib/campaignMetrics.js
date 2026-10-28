// Eventos observados não demonstram venda recebida nem objetivo da campanha.
export const META_EVENTS = {
  conversa: ['onsite_conversion.messaging_conversation_started_7d'],
  lead: ['lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped'],
  compra: ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase'],
}

export function metaResults(actions = []) {
  const metricas = Object.fromEntries(Object.entries(META_EVENTS).map(([tipo, aliases]) => [
    tipo,
    // Aliases podem representar o mesmo evento: nunca somar entre eles.
    Math.max(0, ...aliases.map((alias) => Number(actions?.find((a) => a.action_type === alias)?.value || 0))),
  ]))
  const presentes = Object.keys(metricas).filter((tipo) => metricas[tipo] > 0)
  const tipoResultado = presentes.length === 1 ? presentes[0] : 'indeterminado'
  return { metricas, tipoResultado, resultados: presentes.length === 1 ? metricas[tipoResultado] : null }
}

export function readMetadata(now = new Date(), extra = {}) {
  return {
    consultadoEm: now.toISOString(),
    atualizadoEm: null, // O provedor não informa consolidação nestas consultas.
    fusoConta: null,
    moeda: null,
    atribuicao: 'Configuração do provedor; não verificada neste painel.',
    ...extra,
  }
}

export function normalizeGoogleCampaign(r) {
  const metricas = r.metrics || {}
  return {
    fonte: 'google', id: String(r.campaign.id), nome: r.campaign.name, status: r.campaign.status,
    gasto: Number(metricas.costMicros || 0) / 1_000_000,
    impressoes: Number(metricas.impressions || 0), alcance: null,
    cliques: Number(metricas.clicks || 0), ctr: Number(metricas.ctr || 0) * 100,
    cpm: Number(metricas.averageCpm || 0) / 1_000_000,
    // Manter os campos antigos como indisponíveis, nunca como conversões disfarçadas.
    conversas: null, custoConversa: null,
    tipoResultado: 'conversao', resultados: Number(metricas.conversions || 0),
    custoResultado: Number(metricas.conversions) > 0 && metricas.costPerConversion != null ? Number(metricas.costPerConversion) / 1_000_000 : null,
  }
}
