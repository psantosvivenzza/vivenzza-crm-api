// IA WhatsApp MVP — mock determinístico do AIProvider, usado pelos testes
// locais (AI_PROVIDER=mock) e como fallback sem depender de infraestrutura
// externa. Sem rede, sem custo, 100% previsível: decide por palavra-chave
// simples no texto do usuário — o suficiente para exercitar
// intentClassifier.js/replySuggestion.js de ponta a ponta sem Ollama real.
//
// Dois modos de jsonMode, diferenciados pelo systemPrompt (mesmo padrão de
// "quem pergunta o quê" usado no resto do motor): classificação de intenção
// (pergunta por "intent") vs. geração de resposta sugerida (pergunta por
// "suggested_reply").
const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado']

function ultimoTextoUsuario(messages) {
  return [...messages].reverse().find((m) => m.role === 'user')?.content?.toLowerCase() ?? ''
}

function classificarPorPalavraChave(texto) {
  if (/j[aá] paguei|paguei ontem|paguei hoje|efetuei o pagamento/.test(texto)) return 'JA_PAGUEI'
  if (/n[aã]o reconhe[cç]o|valor est[aá] errado|esse valor|contest/.test(texto)) return 'CONTESTA_VALOR'
  if (/falar com algu[eé]m|atendente|humano|quero um atendente/.test(texto)) return 'QUERO_ATENDENTE'
  if (/manda.*pix|c[oó]digo pix|boleto|segunda via/.test(texto)) return 'PRECISO_BOLETO_PIX'
  if (/n[aã]o consigo pagar agora|sem condi[cç][aã]o|t[oó] sem grana|n[aã]o tenho como pagar/.test(texto)) return 'SEM_CONDICAO_AGORA'
  if (/pago (dia|sexta|segunda|ter[cç]a|quarta|quinta|s[aá]bado|domingo|amanh[aã])|vou pagar/.test(texto)) return 'PEDIDO_NOVA_DATA'
  if (/quero pagar|como (eu )?pago|posso pagar/.test(texto)) return 'QUERO_PAGAR'
  if (/d[uú]vida|como assim|n[aã]o entendi|essa cobran[cç]a/.test(texto)) return 'DUVIDA_GERAL'
  return 'UNKNOWN'
}

function pareceConfuso(texto) {
  return texto.length > 200 || (texto.match(/\?/g) || []).length >= 2 || /n[aã]o sei|sei l[aá]|confus[oa]/.test(texto)
}
function pareceIrritado(texto) {
  return /!!!|p[eé]ssim[oa]|absurdo|inaceit[aá]vel|v[aã]o se|raiva|estou puto|isso [eé] um abuso/.test(texto)
}

// Extração determinística simples de data relativa — suficiente pro MVP/mock;
// a versão real (Ollama) recebe a data de hoje no prompt e extrai sozinha.
function extrairDataRelativa(texto) {
  const hoje = new Date()
  if (/amanh[aã]/.test(texto)) {
    const d = new Date(hoje)
    d.setDate(d.getDate() + 1)
    return d.toISOString().slice(0, 10)
  }
  for (let i = 0; i < DIAS_SEMANA.length; i++) {
    if (texto.includes(DIAS_SEMANA[i])) {
      const d = new Date(hoje)
      const diasAte = (i - d.getDay() + 7) % 7 || 7
      d.setDate(d.getDate() + diasAte)
      return d.toISOString().slice(0, 10)
    }
  }
  const diaDoMes = texto.match(/dia (\d{1,2})/)
  if (diaDoMes) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth(), Number(diaDoMes[1]))
    if (d < hoje) d.setMonth(d.getMonth() + 1)
    return d.toISOString().slice(0, 10)
  }
  return null
}

let provider = null

export function getMockAiProvider() {
  if (provider) return provider

  provider = {
    async chat({ systemPrompt, messages, jsonMode = false }) {
      const texto = ultimoTextoUsuario(messages)

      if (jsonMode && systemPrompt?.includes('suggested_reply')) {
        const extractedDate = extrairDataRelativa(texto)
        return {
          content: JSON.stringify({
            suggested_reply: 'Recebemos sua mensagem, obrigado pelo contato. (resposta simulada — AI_PROVIDER=mock)',
            extracted_date: extractedDate,
          }),
          raw: { mock: true },
        }
      }

      if (jsonMode) {
        const intent = classificarPorPalavraChave(texto)
        const confidence = pareceConfuso(texto) ? 'baixa' : 'alta'
        const cliente_irritado = pareceIrritado(texto)
        return { content: JSON.stringify({ intent, confidence, cliente_irritado }), raw: { mock: true } }
      }

      return { content: 'Recebi sua mensagem, um momento.', raw: { mock: true } }
    },

    async disponivel() {
      return true
    },

    nome: 'mock',
  }
  return provider
}
