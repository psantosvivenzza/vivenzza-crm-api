// Variações de DDD com/sem o 9º dígito, para casar com o mesmo número já cadastrado em leads
// (formato local, sem "55") ou em sdr_conversas (formato do JID do WhatsApp, sempre com "55").
// Vive em lib/ — usado por sdr.js, whatsapp.js e webhook-handler.js — pra evitar import
// circular entre rotas que dependem umas das outras.
export function candidatosTelefone(telefone) {
  const semPrefixo = telefone.replace(/^55/, '')
  const com9 = semPrefixo.length === 10 ? semPrefixo.slice(0, 2) + '9' + semPrefixo.slice(2) : null
  const sem9 = semPrefixo.length === 11 ? semPrefixo.slice(0, 2) + semPrefixo.slice(3) : null
  return [telefone, semPrefixo, com9, sem9, com9 && `55${com9}`, sem9 && `55${sem9}`].filter(Boolean)
}

// Mantém só os dígitos — usado ao salvar telefone de leads criados/editados manualmente,
// pra não ficar parênteses/espaço/hífen impedindo o match com candidatosTelefone depois.
export function normalizarTelefone(telefone) {
  if (!telefone) return telefone
  const digitos = telefone.replace(/\D/g, '')
  return digitos || null
}
