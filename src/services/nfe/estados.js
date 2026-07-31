// Máquina de estados explícita da NF-e — adaptada aos status já usados no
// banco hoje (rascunho/enviada/autorizada/rejeitada/cancelada/denegada +
// emitida_interna/cancelada_interna pra série 99). Não introduz nomes novos
// sem necessidade; só formaliza as transições que o código já fazia
// implicitamente, pra impedir qualquer transição fora dessas regras.

export const STATUS_NFE = [
  'rascunho', 'enviada', 'autorizada', 'rejeitada', 'denegada', 'cancelada',
  'emitida_interna', 'cancelada_interna',
]

// Um documento autorizado é imutável — nenhuma transição parte dele exceto
// pra cancelamento (via evento fiscal real, nunca edição direta do registro).
const TRANSICOES = {
  rascunho:          ['enviada'],
  enviada:           ['autorizada', 'rejeitada', 'denegada', 'rascunho'], // rascunho: erro de comunicação, permite tentar de novo
  autorizada:        ['cancelada'],
  rejeitada:         ['enviada'], // pode tentar emitir de novo
  denegada:          [], // denegação é definitiva pra aquela numeração — não tenta de novo com o mesmo número
  cancelada:         [],
  emitida_interna:   ['cancelada_interna'],
  cancelada_interna: [],
}

export function transicaoValida(statusAtual, statusNovo) {
  if (statusAtual === statusNovo) return false // não é uma transição, é um no-op — trate como erro explícito
  return (TRANSICOES[statusAtual] || []).includes(statusNovo)
}

export function exigirTransicaoValida(statusAtual, statusNovo) {
  if (!transicaoValida(statusAtual, statusNovo)) {
    throw new Error(`Transição de status inválida: "${statusAtual}" → "${statusNovo}"`)
  }
}

export function eImutavel(status) {
  return status === 'autorizada' || status === 'cancelada' ||
    status === 'emitida_interna' || status === 'cancelada_interna'
}
