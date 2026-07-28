// Régua de cobrança — cálculo de etapa e montagem de mensagem.
// Puro/sem I/O de propósito: fácil de testar e reutilizar tanto no cron
// quanto no disparo manual (individual e em massa).

const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtData = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })

// Faixas (não dia exato) — se o cron falhar num dia, ninguém fica de fora
// na próxima execução. `diasAtraso` = hoje - vencimento (negativo = ainda não venceu).
export function calcularEtapa(diasAtraso) {
  if (diasAtraso >= -3 && diasAtraso <= -1) return 1
  if (diasAtraso >= 1 && diasAtraso <= 14) return 2
  if (diasAtraso >= 15 && diasAtraso <= 29) return 3
  if (diasAtraso >= 30 && diasAtraso <= 59) return 4
  if (diasAtraso >= 60) return 5
  return null
}

export function montarMensagem(etapa, { nome, valor, vencimento, diasAtraso }) {
  const chavePix = process.env.CHAVE_PIX_VIVENZZA || '[CHAVE PIX NÃO CONFIGURADA]'
  const numero = process.env.FINANCEIRO_WHATSAPP_NUMBER || '[NÚMERO NÃO CONFIGURADO]'
  const valorFmt = fmtBRL(valor)
  const dataFmt = fmtData(vencimento)

  switch (etapa) {
    case 1:
      return `Olá, ${nome}! 👋 Aqui é a Vivenzza Professional.\n` +
        `Passando para lembrar que seu boleto de ${valorFmt} vence em 3 dias, no dia ${dataFmt}.\n` +
        `Para facilitar, você pode pagar via PIX: ${chavePix}\n` +
        `Qualquer dúvida, estamos à disposição! 😊`
    case 2:
      return `Olá, ${nome}! Identificamos que seu boleto de ${valorFmt} venceu ontem, dia ${dataFmt}.\n` +
        `Caso já tenha realizado o pagamento, desconsidere esta mensagem.\n` +
        `Caso contrário, entre em contato para regularizar.\n` +
        `PIX: ${chavePix} 💙`
    case 3:
      return `Olá, ${nome}. A Vivenzza Professional informa que consta em aberto o valor de ${valorFmt} ` +
        `com vencimento em ${dataFmt} (${diasAtraso} dias em atraso).\n` +
        `Solicitamos a regularização o quanto antes para evitar restrições em futuras compras.\n` +
        `Fale conosco: ${numero}`
    case 4:
      return `${nome}, informamos que seu débito de ${valorFmt} está há ${diasAtraso} dias em atraso.\n` +
        `Para negociação ou acordo de pagamento, entre em contato imediatamente.\n` +
        `📞 Financeiro Vivenzza: ${numero}`
    case 5:
      return `${nome}, seu débito de ${valorFmt} está há ${diasAtraso} dias em atraso. ` +
        `Esta é uma comunicação formal da Vivenzza Professional solicitando regularização imediata do débito.\n` +
        `Em caso de não pagamento, tomaremos as medidas cabíveis. Entre em contato: ${numero}`
    default:
      throw new Error(`Etapa inválida: ${etapa}`)
  }
}
