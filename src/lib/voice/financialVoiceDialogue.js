import { avaliarConfirmacaoResponsavel, ehNegacaoDeIdentidade } from './guardaConteudo.js'

const resposta = (texto, intent = 'DUVIDA_GERAL', requiresHuman = false) => ({
  respostaTexto: texto, intent, requiresHuman, confidence: 1, aiProvider: 'deterministic',
})

// Financial amounts never go to the language model. Each disclosure is freshly guarded.
export async function responderCobrancaVoz(texto, estado, consultar) {
  const fala = String(texto ?? '').toLowerCase()
  if (ehNegacaoDeIdentidade(fala) && (!estado.responsavelConfirmado || !/^\s*n[ãa]o\s*[.,!]?\s*$/.test(fala))) {
    estado.responsavelConfirmado = false
    estado.etapaFinanceira = 'identificacao'
    return resposta('Entendo. Não vou tratar desse assunto com terceiros. Obrigada pela atenção.', 'NAO_E_O_RESPONSAVEL')
  }
  if (/\b(atendente|humano|pessoa|operador)\b/.test(fala)) {
    return resposta('Vou solicitar o atendimento da nossa equipe.', 'QUERO_ATENDENTE', true)
  }
  if (!estado.responsavelConfirmado) {
    if (!avaliarConfirmacaoResponsavel(fala)) {
      return resposta('Sou a assistente virtual da Vivenzza Professional. Posso falar com o responsável pelo cadastro?')
    }
    estado.responsavelConfirmado = true
    estado.etapaFinanceira = 'disponibilidade'
    return resposta('Obrigada por confirmar. Você pode conversar agora?')
  }
  const negouPagamento = /\bn[ãa]o\b.{0,24}\b(paguei|pago|pague|pagamento|quitei|quitado)\b/.test(fala)
  if (!negouPagamento && /\b(paguei|pago|quitado|quitei|já pag|ja pag)\b/.test(fala)) {
    return resposta('Obrigada pela informação. O pagamento precisa ser conferido pela equipe financeira antes de qualquer novo contato.', 'JA_PAGOU', true)
  }
  if (/\b(não reconheço|nao reconheco|discordo|indevid|contest|errad)\b/.test(fala)) {
    return resposta('Entendo. Essa divergência precisa ser analisada pela equipe financeira.', 'CONTESTACAO', true)
  }
  if (estado.etapaFinanceira === 'disponibilidade') {
    if (/\b(não|nao|depois|ocupad)\b/.test(fala)) return resposta('Sem problema. Obrigada pela atenção.', 'SEM_DISPONIBILIDADE', true)
    if (!avaliarConfirmacaoResponsavel(fala)) return resposta('Você pode conversar agora?')
  }
  const contexto = await consultar()
  if (!contexto.permitido) {
    return resposta('Não tenho informações confirmadas para tratar desse assunto agora. Nossa equipe financeira precisa conferir o cadastro.', 'CONFERENCIA_FINANCEIRA', true)
  }
  if (estado.etapaFinanceira === 'disponibilidade') {
    estado.etapaFinanceira = 'pagamento'
    const valor = (contexto.saldoCentavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    const data = contexto.vencimento.split('-').reverse().join('/')
    return resposta(`Consta um saldo em aberto de ${valor}, com vencimento mais antigo em ${data}. Esse pagamento já foi realizado?`)
  }
  // No promise is claimed to be recorded: this flow has no financial write authority.
  return resposta('Entendo. A equipe financeira pode conferir a situação e conversar sobre uma previsão de pagamento.', 'CONFERENCIA_FINANCEIRA', true)
}
