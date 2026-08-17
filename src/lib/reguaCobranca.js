// Régua de cobrança — cálculo de etapa e montagem de mensagem.
// Puro/sem I/O de propósito: fácil de testar e reutilizar tanto no cron
// quanto no disparo manual (individual e em massa).

const NOME_OPERADOR = 'Jeffeson'

// Reservado pra quando o link de pagamento for integrado — nenhuma das 8 mensagens
// atuais usa isso ainda (todas usam PIX por CNPJ), mantido pronto pra plugar depois.
export const LINK_PAGAMENTO = '[Link de pagamento]'

const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// `vencimento` vem do banco como 'YYYY-MM-DD' sem horário (coluna `date`).
// new Date('2026-07-31') é interpretado como meia-noite UTC — convertendo pra
// America/Sao_Paulo (UTC-3) isso vira 30/07 às 21h, exibindo o dia errado pro
// cliente. Formata os componentes da string direto, sem passar por Date/fuso.
const fmtData = (d) => {
  const [ano, mes, dia] = String(d).slice(0, 10).split('-')
  return `${dia}/${mes}/${ano}`
}

// FINANCEIRO_WHATSAPP_NUMBER é o número que envia (formato Evolution API, ex:
// "5551983270024") — formata pra exibição humana ("(51) 98327-0024") a partir da
// MESMA env var, pra nunca ficar um número na mensagem e outro enviando de fato.
function telefoneExibicao() {
  const digitos = String(process.env.FINANCEIRO_WHATSAPP_NUMBER || '').replace(/\D/g, '')
  if (digitos.length === 13 && digitos.startsWith('55')) {
    const ddd = digitos.slice(2, 4)
    const resto = digitos.slice(4)
    return `(${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`
  }
  return '[TELEFONE NÃO CONFIGURADO]'
}

// Faixas (não dia exato) — se o cron falhar num dia, ninguém fica de fora na
// próxima execução. Cada faixa começa exatamente no dia-alvo da etapa (D-3, D-1,
// D+1, D+3, D+7, D+15, D+30, D+60) e vai até o dia anterior ao alvo da próxima
// etapa — cobertura contínua, sem buracos nem sobreposição. `diasAtraso` =
// hoje - vencimento (negativo = ainda não venceu).
export function calcularEtapa(diasAtraso) {
  if (diasAtraso >= -3 && diasAtraso <= -2) return 1  // D-3 a D-2
  if (diasAtraso >= -1 && diasAtraso <= 0) return 2   // D-1 a D0
  if (diasAtraso >= 1 && diasAtraso <= 2) return 3    // D+1 a D+2
  if (diasAtraso >= 3 && diasAtraso <= 6) return 4    // D+3 a D+6
  if (diasAtraso >= 7 && diasAtraso <= 14) return 5   // D+7 a D+14
  if (diasAtraso >= 15 && diasAtraso <= 29) return 6  // D+15 a D+29
  if (diasAtraso >= 30 && diasAtraso <= 59) return 7  // D+30 a D+59
  if (diasAtraso >= 60) return 8                       // D+60 em diante
  return null
}

// Wrapper aditivo (2026-08-17) — a função original abaixo (montarMensagemPorEtapa)
// não foi alterada em nenhum caractere: pra quantidadeTitulos=1 (o padrão, e o
// único caso que existia antes), o retorno é byte-a-byte idêntico ao de sempre.
// Quando 2+ títulos do mesmo cliente vencem na mesma data (ver
// collection/consolidacaoParcelas.js), `valor` já vem como a SOMA dos saldos —
// isso sozinho já resolve o requisito central. A nota abaixo é só o "opcional"
// do pedido (deixar explícito que é uma parcela consolidada), inserida antes da
// assinatura (sempre a última linha de toda mensagem).
export function montarMensagem(etapa, { quantidadeTitulos = 1, ...dados }) {
  const base = montarMensagemPorEtapa(etapa, dados)
  if (quantidadeTitulos < 2) return base

  const assinatura = `_${NOME_OPERADOR} — Financeiro Vivenzza_`
  const nota = `Esse valor corresponde a ${quantidadeTitulos} títulos com o mesmo vencimento.`
  if (base.endsWith(assinatura)) {
    return `${base.slice(0, -assinatura.length)}${nota}\n${assinatura}`
  }
  return `${base}\n${nota}` // defensivo — não deveria acontecer, nenhuma etapa deixa de assinar
}

function montarMensagemPorEtapa(etapa, { nome, valor, vencimento, diasAtraso }) {
  const chavePix = process.env.CHAVE_PIX_VIVENZZA || '[CHAVE PIX NÃO CONFIGURADA]'
  const telefone = telefoneExibicao()
  const valorFmt = fmtBRL(valor)
  const dataFmt = fmtData(vencimento)
  const assinatura = `_${NOME_OPERADOR} — Financeiro Vivenzza_`

  switch (etapa) {
    case 1:
      return `Olá, ${nome}! Tudo bem? Aqui é ${NOME_OPERADOR}, do Financeiro Vivenzza Professional.\n` +
        `Passando para lembrar que o pagamento de *R$ ${valorFmt}* vence em *${dataFmt}*.\n` +
        `Para facilitar, você pode pagar via PIX:\n` +
        `🔑 *CNPJ: ${chavePix}*\n` +
        `Se precisar de qualquer apoio, é só me chamar. 😊\n` +
        assinatura

    case 2:
      return `Olá, ${nome}! Aqui é ${NOME_OPERADOR}, da Vivenzza.\n` +
        `Seu pagamento de *R$ ${valorFmt}* vence *amanhã, ${dataFmt}*.\n` +
        `PIX para facilitar: *CNPJ ${chavePix}*\n` +
        `Se já estiver organizado, pode desconsiderar. Obrigado! 💙\n` +
        assinatura

    case 3:
      return `Olá, ${nome}! Tudo bem? Aqui é ${NOME_OPERADOR}, do Financeiro Vivenzza.\n` +
        `Identificamos que o pagamento de *R$ ${valorFmt}*, vencido em *${dataFmt}*, ainda aparece em aberto.\n` +
        `PIX: *CNPJ ${chavePix}*\n` +
        `Se preferir, responda com uma opção:\n` +
        `*1* — Vou pagar hoje\n` +
        `*2* — Já paguei\n` +
        `*3* — Preciso negociar\n` +
        `Estou à disposição para resolvermos isso da melhor forma. 😊\n` +
        assinatura

    case 4:
      return `Olá, ${nome}! Sou ${NOME_OPERADOR}, do Financeiro Vivenzza.\n` +
        `Quero te ajudar a resolver o pagamento de *R$ ${valorFmt}*, vencido em *${dataFmt}*.\n` +
        `Você consegue me confirmar uma previsão de pagamento ou prefere que eu monte uma condição para regularização?\n` +
        `📞 ${telefone}\n` +
        assinatura

    case 5:
      return `Olá, ${nome}. Estou retornando sobre o valor de *R$ ${valorFmt}*, em aberto desde *${dataFmt}*.\n` +
        `Para mantermos seu cadastro regular e evitar qualquer impacto nos próximos pedidos, precisamos definir uma previsão de pagamento.\n` +
        `Você prefere:\n` +
        `*1* — Pagar à vista pelo PIX\n` +
        `*2* — Negociar uma data\n` +
        `*3* — Falar com o Financeiro\n` +
        `PIX: *CNPJ ${chavePix}*\n` +
        `📞 ${telefone}\n` +
        assinatura

    case 6:
      return `Olá, ${nome}. Aqui é ${NOME_OPERADOR}, do Financeiro Vivenzza.\n` +
        `O pagamento de *R$ ${valorFmt}*, vencido em *${dataFmt}*, segue pendente há *${diasAtraso} dias*.\n` +
        `Precisamos regularizar ou formalizar uma negociação para manter seu cadastro apto a novas compras.\n` +
        `Fale comigo por aqui ou pague via PIX: *CNPJ ${chavePix}*\n` +
        `📞 ${telefone}\n` +
        assinatura

    case 7:
      return `Olá, ${nome}. Estamos entrando em contato para concluir a regularização do débito de *R$ ${valorFmt}*, em aberto há *${diasAtraso} dias*.\n` +
        `Ainda podemos buscar uma solução amigável. Me confirme hoje se prefere pagamento à vista ou negociação.\n` +
        `PIX: *CNPJ ${chavePix}*\n` +
        `📞 ${telefone}\n` +
        assinatura

    case 8:
      return `Prezado(a) ${nome},\n` +
        `Consta em aberto o débito de *R$ ${valorFmt}*, vencido em *${dataFmt}*, atualmente com *${diasAtraso} dias* de atraso.\n` +
        `Solicitamos contato imediato com o Financeiro Vivenzza para regularização ou formalização de acordo.\n` +
        `📞 Financeiro Vivenzza: ${telefone}\n` +
        `PIX: *CNPJ ${chavePix}*\n` +
        assinatura

    default:
      throw new Error(`Etapa inválida: ${etapa}`)
  }
}
