// Extração do Click ID de anúncio Click-to-WhatsApp (ctwa_clid).
//
// Achado 01/10/2026: 0 de 1.376 leads dos últimos 30 dias tinham ctwa_clid, mesmo
// com ~220 conversas/semana vindas de anúncios do Meta. A detecção antiga só olhava
// dois caminhos fixos (msg.referral.ctwa_clid e msg.message.<tipo>.contextInfo
// .externalAdReply.ctwaClid). Dependendo da versão da Evolution/Baileys, o clid chega
// em outro nível (ex.: msg.contextInfo, msg.message.messageContextInfo, tipos de
// mensagem não listados). Aqui a busca é recursiva por qualquer chave ctwaClid /
// ctwa_clid, com limite de profundidade, e os caminhos conhecidos continuam tendo
// prioridade.

const CHAVES_CLID = new Set(['ctwaclid', 'ctwa_clid'])
const MAX_PROFUNDIDADE = 8

export function buscarCtwaClidRecursivo(obj, profundidade = 0) {
  if (!obj || typeof obj !== 'object' || profundidade > MAX_PROFUNDIDADE) return null
  for (const [chave, valor] of Object.entries(obj)) {
    if (CHAVES_CLID.has(chave.toLowerCase()) && typeof valor === 'string' && valor.length > 0) {
      return valor
    }
  }
  for (const valor of Object.values(obj)) {
    if (valor && typeof valor === 'object') {
      const achado = buscarCtwaClidRecursivo(valor, profundidade + 1)
      if (achado) return achado
    }
  }
  return null
}

export function detectarCtwaClid(msg) {
  if (!msg || typeof msg !== 'object') return null

  // Caminhos conhecidos (prioridade)
  const ref = msg.referral
  if (ref?.ctwa_clid) return ref.ctwa_clid

  const tipos = ['extendedTextMessage', 'imageMessage', 'videoMessage', 'buttonsMessage']
  for (const tipo of tipos) {
    const adReply = msg.message?.[tipo]?.contextInfo?.externalAdReply
    if (adReply?.ctwaClid) return adReply.ctwaClid
  }

  // Fallback: busca recursiva em qualquer nível
  return buscarCtwaClidRecursivo(msg)
}

// Diagnóstico SEM dados pessoais: só os NOMES das chaves que indicam anúncio
// (nunca valores, texto de mensagem ou telefone). Usado para descobrir onde o
// Meta/Evolution entrega o clid quando ele não é encontrado.
const PADRAO_CAMINHO_AD = /ctwa|externalAdReply|referral|conversionSource|entryPoint|adReply|sourceUrl/i

export function caminhosIndicioAnuncio(obj, caminho = 'msg', profundidade = 0, saida = []) {
  if (!obj || typeof obj !== 'object' || profundidade > MAX_PROFUNDIDADE || saida.length >= 12) return saida
  for (const [chave, valor] of Object.entries(obj)) {
    const atual = `${caminho}.${chave}`
    if (PADRAO_CAMINHO_AD.test(chave)) saida.push(atual)
    if (valor && typeof valor === 'object') caminhosIndicioAnuncio(valor, atual, profundidade + 1, saida)
    if (saida.length >= 12) break
  }
  return saida
}
