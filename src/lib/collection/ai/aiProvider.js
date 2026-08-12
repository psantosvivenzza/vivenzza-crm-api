// IA WhatsApp MVP — interface AIProvider. O resto do sistema (intentClassifier.js,
// replySuggestion.js) só fala com AIProvider, nunca com o SDK/HTTP de um provedor
// específico — permite trocar de provider sem tocar no domínio.
//
// Contrato:
//   async chat({ systemPrompt, messages, jsonMode }) => { content, raw }
//     - `messages`: [{ role: 'user', content }]
//     - retorna `content` (texto; se jsonMode=true, é uma string JSON)
//   async disponivel() => boolean — healthcheck rápido; se false, o fluxo
//     escala pra humano em vez de tentar conversar com um provider fora do ar.
import { getOllamaProvider } from './ollamaProvider.js'
import { getMockAiProvider } from './mockAiProvider.js'

let instancia = null

// AI_PROVIDER:
//   'ollama' (default) — chama Ollama diretamente via HTTP (OLLAMA_BASE_URL).
//   'mock'              — determinístico, sem rede — testes/CI.
export function getAIProvider() {
  if (instancia) return instancia
  const tipo = process.env.AI_PROVIDER || 'ollama'
  instancia = tipo === 'mock' ? getMockAiProvider() : getOllamaProvider()
  return instancia
}

// Exportado para os scripts de teste poderem injetar o mock explicitamente sem
// depender da env var.
export function _resetProviderParaTeste(provider) {
  instancia = provider
}
