// Monta a frase de abertura da ligação de cobrança.
//
// BASE: pesquisa de mercado (17/09/2026) sobre scripts reais de cobrança
// por telefone no Brasil (Receiv, Assertiva, Stalo), agentes de voz por IA
// (Prodigal, JustCall) e cobrança B2B (Chaser, Quadient), cruzada com o
// Art. 42 do CDC e a LGPD.
//
// A sequência obrigatória é de QUATRO passos, nunca três:
//   1. Me identifico (marca + assistente virtual)
//   2. Peço a PESSOA pelo nome (ou, sem nome, a FUNÇÃO — nunca "o devedor")
//   3. Ela confirma que é
//   4. SÓ ENTÃO entram título, valor e vencimento
//
// O passo 2 não é cortesia: é o que impede que a recepcionista, o
// cabeleireiro ou quem mais atendeu o telefone ouça falar de dívida. Expor
// a cobrança a terceiro é exatamente a prática que o Art. 42 do CDC pune, e
// já há condenação por isso.
//
// Também nunca dizemos "cobrança", "setor de cobrança", "débito", "atraso"
// ou "inadimplente" na abertura — além do risco jurídico, enquadra a
// Vivenzza como cobradora e destrói o posicionamento premium. O vocabulário
// permitido antes da confirmação é NEUTRO, porque a carteira tem salão E
// distribuidor: "assunto comercial", "assunto comercial do seu interesse",
// "pendência no cadastro". Nunca "conta do salão" — chamar distribuidor de
// salão diminui o cliente e entrega que quem fala é um robô com roteiro de
// varejo.

// "MARIA DA SILVA COMERCIO DE COSMETICOS LTDA" -> "Maria"
// "SALAO BELEZA PURA ME" -> null (é nome de empresa, não de pessoa)
const SUFIXOS_EMPRESA = /^(ltda|me|epp|eireli|s\/?a|sa|mei|com|comercio|comércio|distribuidor|distribuidora|salao|salão|studio|st[uú]dio|est[uú]dio|beauty|hair|espaco|espaço|centro|instituto|clinica|clínica|casa|loja|grupo|rede|belez[ao]|cabelereiro|cabeleireiro|barbearia|barber)$/i

export function primeiroNome(nomeCompleto) {
  if (!nomeCompleto) return null
  const limpo = String(nomeCompleto).trim().replace(/\s+/g, ' ')
  if (!limpo) return null
  const primeiro = limpo.split(' ')[0]
  if (primeiro.length < 3) return null
  if (SUFIXOS_EMPRESA.test(primeiro)) return null
  if (/\d/.test(primeiro)) return null
  return primeiro.charAt(0).toUpperCase() + primeiro.slice(1).toLowerCase()
}

const MARCA = 'aqui é a assistente virtual da Vivenzza Professional'

// A janela de ligação abre às 08:00 e fecha às 18:40, então "boa tarde"
// fixo faz a marca dar bom dia às 17h e boa tarde às 8h. Detalhe pequeno
// que soa amador logo na primeira frase.
export function saudacaoDoDia(agora = new Date()) {
  const hora = Number(
    new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false })
      .format(agora)
      .replace(/\D/g, ''),
  ) % 24
  if (hora < 12) return 'bom dia'
  if (hora < 18) return 'boa tarde'
  return 'boa noite'
}

export function montarSaudacao(clienteNome, agora = new Date()) {
  const nome = primeiroNome(clienteNome)
  const periodo = saudacaoDoDia(agora)
  // Vírgulas e frases curtas não são estética: o Piper respira na
  // pontuação. Frase longa sem vírgula sai atropelada, que foi o relato
  // ("não está fluindo, quebra a palavra").
  if (nome) {
    return `Olá, ${periodo}. ${MARCA.charAt(0).toUpperCase()}${MARCA.slice(1)}. Falo com ${nome}?`
  }
  return `Olá, ${periodo}. ${MARCA.charAt(0).toUpperCase()}${MARCA.slice(1)}. Eu falo com o responsável pelo financeiro, por favor?`
}

// A resposta fixa a terceiro MORA em guardaConteudo.js (que e quem aplica o
// filtro). Mantida so la para nao existirem duas versoes da mesma frase.

export const FRASE_NAO_ENTENDI = 'Desculpa, não consegui te ouvir bem. Pode repetir, por favor?'
export function fraseDespedida(agora = new Date()) {
  return `Tudo bem. Vou encerrar por aqui, e a Vivenzza retorna depois. Obrigada, e ${saudacaoDoDia(agora)}!`
}

// Encerramento de conversa que foi BEM, depois de os turnos se esgotarem.
// Nunca desligar calado: do lado do cliente, silêncio é "caiu a ligação".
export function fraseEncerramentoNormal(agora = new Date()) {
  return `Perfeito, obrigada pela atenção. A Vivenzza segue à disposição. Tenha ${saudacaoDoDia(agora) === 'bom dia' ? 'um bom dia' : saudacaoDoDia(agora) === 'boa tarde' ? 'uma boa tarde' : 'uma boa noite'}!`
}

// Quando a pessoa pede para falar com um humano. Desligar em cima desse
// pedido é a pior coisa que um robô de cobrança pode fazer.
export const FRASE_TRANSFERIR_HUMANO =
  'Claro. Vou registrar aqui e uma pessoa da Vivenzza entra em contato com você. Obrigada pela atenção!'
