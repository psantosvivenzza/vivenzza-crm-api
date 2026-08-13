// Voice AI MVP — reaproveita o classificador de intenção e os guardrails
// EXATAMENTE do WhatsApp (intentClassifier/aiProvider, INTENTS_SEMPRE_HUMANO)
// — mesma taxonomia, mesmas regras de human handoff, nunca um segundo motor
// de decisão para ISSO. A geração de resposta usa um prompt PRÓPRIO da voz
// (mais enxuto que o do WhatsApp) — decisão deliberada de latência: o
// prompt do WhatsApp inclui um bloco de contexto financeiro que, no
// INTERNAL_TEST de voz, é sempre null/false (não muda o comportamento do
// modelo, só gasta tokens/tempo), e a resposta de voz precisa ser curta
// (1-2 frases) por natureza do canal — algo que o prompt do WhatsApp não
// pede. As REGRAS continuam as mesmas (nunca prometer desconto/parcelamento,
// nunca confirmar pagamento sem confirmação) — só o texto do prompt é mais
// direto.
//
// FASE INTERNAL_TEST: nunca associa a uma conta financeira/cliente real —
// mesmo espírito do INTERNAL_TEST já homologado no WhatsApp (C.3B/C.3D):
// sem persistir nada, sem promessa real, sem mutação financeira. Não chama
// montarSugestaoFinal/registrarSugestao — é o harness de homologação da
// ligação, não o fluxo de produção.
import { classificarIntencao } from '../collection/ai/intentClassifier.js'
import { validarGeracao, INTENTS_SEMPRE_HUMANO } from '../collection/ai/replySuggestion.js'
import { getAIProvider } from '../collection/ai/aiProvider.js'

const VOICE_GERACAO_SYSTEM_PROMPT = `Você é um assistente de voz de cobrança da Vivenzza, respondendo por telefone em português do Brasil.
Responda em NO MÁXIMO 2 frases curtas, direto ao ponto, cordial — está sendo ouvido, não lido.
NUNCA prometa desconto, parcelamento ou condição especial.
NUNCA confirme pagamento sem confirmação explícita.
Responda APENAS com um JSON válido: {"suggested_reply": "<resposta curta>"}
Não adicione texto fora do JSON.`

async function gerarRespostaVoz(textoTranscrito, intent) {
  const provider = getAIProvider()
  const systemPrompt = `${VOICE_GERACAO_SYSTEM_PROMPT}\nIntenção já classificada: ${intent}.`
  const resposta = await provider.chat({ systemPrompt, messages: [{ role: 'user', content: textoTranscrito }], jsonMode: true })
  let parsed = null
  try {
    parsed = JSON.parse(resposta.content ?? '')
  } catch {
    parsed = null
  }
  return validarGeracao(parsed) ?? { suggestedReply: 'Desculpe, não consegui processar sua fala. Pode repetir?', extractedDate: null }
}

export async function responderTurno(textoTranscrito) {
  const classificacao = await classificarIntencao(textoTranscrito)
  // Mesma regra do WhatsApp: alguns intents SEMPRE exigem humano,
  // independente de confidence — classificarIntencao() sozinho não aplica
  // essa camada (ela vive em replySuggestion.js/montarSugestaoFinal), então
  // reaplica aqui pra não perder o guardrail só porque a voz não persiste
  // suggestion.
  const requiresHuman = classificacao.needsHuman || INTENTS_SEMPRE_HUMANO.has(classificacao.intent)

  const geracao = await gerarRespostaVoz(textoTranscrito, classificacao.intent)

  return {
    intent: classificacao.intent,
    confidence: classificacao.confidence,
    requiresHuman,
    respostaTexto: geracao.suggestedReply || 'Desculpe, não consegui gerar uma resposta.',
    aiProvider: getAIProvider().nome,
  }
}

// Chamado uma vez na subida do serviço — carrega o modelo na memória do
// Ollama antes da primeira ligação real, pra não pagar o custo de "cold
// start" durante uma chamada de verdade. Resultado descartado de propósito.
export async function aquecerCerebro() {
  await responderTurno('teste de aquecimento do modelo, ignorar')
}
