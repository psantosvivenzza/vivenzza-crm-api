// Explicitly scoped to the site campaign. No automatic instance failover.
export const SITE_CAMPAIGN = Object.freeze({
  code: 'VOLTE10',
  discount: 10,
  expiresAt: '2026-10-31T02:59:59.999Z',
  url: 'https://loja.vivenzzaprofessional.com.br/discount/VOLTE10',
})

export function siteCampaignContext(event, env = process.env) {
  const expected = env.SDR_SITE_INSTANCE?.trim()
  if (env.SDR_SITE_ENABLED !== 'true' || !expected) return null
  const instance = event?.instance ?? event?.instanceName
  if (instance !== expected || expected === (env.EVOLUTION_INSTANCE || 'vivenzza')) return null
  return { instance, siteCampaign: true }
}

export function siteCampaignInstructions(now = new Date()) {
  const valid = now.getTime() <= Date.parse(SITE_CAMPAIGN.expiresAt)
  return `\nCONTEXTO PRIORITÁRIO — ATENDIMENTO DO SITE VIVENZZA:
Você atende clientes que já compraram na loja, após a campanha VOLTE10.
Fale em nome da Vivenzza, sem se apresentar como pessoa ou vendedora.
Ajude a escolher produtos perguntando sobre cabelo, química e necessidade.
Use o conhecimento técnico acima. Nunca invente preço, estoque ou entrega.
Encaminhe para a equipe quando não houver informação segura ou pedirem humano.
O cupom VOLTE10 oferece 10% de desconto, sem mínimo, um uso por cliente,
sem combinar com outras promoções, sem desconto sobre frete.
Validade: 30/10/2026 às 23h59, horário de Brasília.
${valid ? 'O cupom está no período de validade.' : 'O cupom venceu. Não ofereça desconto nem diga que ainda está válido.'}
Link oficial: ${SITE_CAMPAIGN.url}
Atenda por texto; não envie áudio nem catálogo automaticamente.
Não faça novos disparos promocionais: responda somente à dúvida recebida.
Respeite imediatamente qualquer pedido de parar mensagens.
Retorne o mesmo JSON solicitado acima, com resposta em resposta e audio_script=null.`
}

export function isStopRequest(text = '') {
 const s=String(text).normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase()
 if (/nao\s+par[ae]\s+de/.test(s)) return false
 return /^(sair|stop|pare|parar|cancelar|chega)[.! ]*$/.test(s) || /descadastr|nao\s+me\s+(mande|manda|envie|chame)|nao\s+(mande|manda|envie)\s+(mais|mensage|oferta)|nao\s+(quero|desejo)\s+(mais\s+)?(receber|mensage)|par[ae]\s+de\s+(me\s+)?(mandar|enviar)|remov[ae]\s+(meu\s+)?(contato|numero|telefone)/.test(s)
}
export function enforceSiteCampaignReply(text, now = new Date()) {
 if(now.getTime()>Date.parse(SITE_CAMPAIGN.expiresAt) && /VOLTE10|cupom|desconto|10\s*%/i.test(text)) return 'O cupom VOLTE10 encerrou em 30/10/2026. Posso ajudar você a escolher os produtos na nossa loja: https://loja.vivenzzaprofessional.com.br'
 return text
}
