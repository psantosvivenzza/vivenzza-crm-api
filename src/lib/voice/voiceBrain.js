// Voice AI MVP — reaproveita EXATAMENTE o mesmo cérebro do WhatsApp
// (intentClassifier/replySuggestion/aiProvider), a mesma taxonomia de
// intenção, os mesmos guardrails (negotiation_policies, human handoff). A
// voz só troca o transporte (áudio em vez de texto de WhatsApp) — nunca cria
// um segundo motor de decisão.
//
// FASE INTERNAL_TEST: nunca associa a uma conta financeira/cliente real —
// mesmo espírito do INTERNAL_TEST já homologado no WhatsApp (C.3B/C.3D):
// contexto vazio, sem persistir nada, sem promessa real, sem mutação
// financeira. Não chama montarSugestaoFinal/registrarSugestao — não é o
// fluxo de produção do WhatsApp, é o harness de homologação da ligação.
import { classificarIntencao } from '../collection/ai/intentClassifier.js'
import { construirPromptGeracao, validarGeracao, INTENTS_SEMPRE_HUMANO } from '../collection/ai/replySuggestion.js'
import { getAIProvider } from '../collection/ai/aiProvider.js'

const CONTEXTO_INTERNAL_TEST = Object.freeze({ titulo: null, promessaAtiva: null, quitado: false, politica: null })

export async function responderTurno(textoTranscrito) {
  const classificacao = await classificarIntencao(textoTranscrito)
  // Mesma regra do WhatsApp: alguns intents SEMPRE exigem humano,
  // independente de confidence — classificarIntencao() sozinho não aplica
  // essa camada (ela vive em replySuggestion.js/montarSugestaoFinal), então
  // reaplica aqui pra não perder o guardrail só porque a voz não persiste
  // suggestion.
  const requiresHuman = classificacao.needsHuman || INTENTS_SEMPRE_HUMANO.has(classificacao.intent)

  const provider = getAIProvider()
  const systemPrompt = construirPromptGeracao({ contexto: CONTEXTO_INTERNAL_TEST, intent: classificacao.intent })
  const resposta = await provider.chat({ systemPrompt, messages: [{ role: 'user', content: textoTranscrito }], jsonMode: true })
  let parsed = null
  try {
    parsed = JSON.parse(resposta.content ?? '')
  } catch {
    parsed = null
  }
  const geracao = validarGeracao(parsed) ?? { suggestedReply: 'Desculpe, não consegui processar sua fala. Pode repetir?', extractedDate: null }

  return {
    intent: classificacao.intent,
    confidence: classificacao.confidence,
    requiresHuman,
    respostaTexto: geracao.suggestedReply || 'Desculpe, não consegui gerar uma resposta.',
    aiProvider: provider.nome,
  }
}
