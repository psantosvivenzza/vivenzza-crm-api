// DDDs válidos no Brasil — mesma lista usada pelo frontend (LeadForm.jsx) pra avisar sobre
// DDD desconhecido. Aqui serve pra decidir se um número de 10/11 dígitos é local brasileiro
// (precisa do "55" na frente pro JID do WhatsApp) ou já é um número internacional completo
// (ex: Uruguai "598...", que também cai em 11 dígitos e seria corrompido por um "55" cego).
const DDDS_VALIDOS = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
])

// Garante o "55" (código do Brasil) na frente do número pro formato exigido pela Evolution
// API — mas só quando o número for local brasileiro (10/11 dígitos com DDD válido). Números
// internacionais já vêm completos (ex: Uruguai +598) e não podem ganhar um "55" cego na
// frente, senão o envio vira um JID inexistente e a mensagem nunca chega (caso real: lead
// "1838 - Adrian Molina", +598 94173195 — ver diagnóstico de 2026-07-13).
export function paraJidWhatsapp(numero) {
  const digitos = numero.replace(/\D/g, '')
  const eLocalBrasileiro = (digitos.length === 10 || digitos.length === 11) && DDDS_VALIDOS.has(digitos.slice(0, 2))
  return eLocalBrasileiro ? `55${digitos}` : digitos
}

// Variações de DDD com/sem o 9º dígito, para casar com o mesmo número já cadastrado em leads
// (formato local, sem "55") ou em sdr_conversas (formato do JID do WhatsApp, sempre com "55").
// Vive em lib/ — usado por sdr.js, whatsapp.js e webhook-handler.js — pra evitar import
// circular entre rotas que dependem umas das outras.
export function candidatosTelefone(telefone) {
  // "55" só é código de país quando sobra DDD+local depois dele (12 ou 13 dígitos no total).
  // Com 10 ou 11 dígitos o número já está em formato local — um "55" inicial é o próprio DDD
  // (Caxias do Sul/RS e região) e não pode ser removido, senão o DDD some e o candidato vira
  // um número de 9 dígitos sem DDD, que nunca casa com o telefone salvo (bug real, causou
  // leads duplicados para clientes com DDD 55 — ver diagnóstico de 2026-07-08).
  const temCodigoPais = telefone.length >= 12 && telefone.startsWith('55')
  const semPrefixo = temCodigoPais ? telefone.replace(/^55/, '') : telefone
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
