// IA WhatsApp MVP — implementação AIProvider sobre Ollama local. Único lugar
// que fala o protocolo HTTP do Ollama — mesmo padrão de isolamento do
// evolutionAdapter.js/evolutionFinanceiro.js.
//
// OLLAMA_BASE_URL aponta pra onde o Ollama está rodando — não precisa ser a
// mesma máquina do backend. OLLAMA_MODEL precisa suportar structured/JSON
// output (qwen2.5:7b-instruct, já validado em benchmark local).
import axios from 'axios'

const BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct'
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 30000)

function client() {
  return axios.create({ baseURL: BASE_URL, timeout: TIMEOUT_MS })
}

let provider = null
export function getOllamaProvider() {
  if (provider) return provider

  provider = {
    async chat({ systemPrompt, messages, jsonMode = false, options }) {
      const payload = {
        model: MODEL,
        stream: false,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        ...(jsonMode ? { format: 'json' } : {}),
        // `options` é opt-in (nenhum caller existente passa isso hoje) —
        // usado pelo voiceBrain.js pra limitar num_predict e reduzir a
        // cauda de latência de respostas de voz, sem afetar o WhatsApp.
        ...(options ? { options } : {}),
      }
      const { data } = await client().post('/api/chat', payload)
      return { content: data?.message?.content ?? null, raw: data }
    },

    async disponivel() {
      try {
        await client().get('/api/tags', { timeout: 3000 })
        return true
      } catch {
        return false
      }
    },

    nome: `ollama:${MODEL}`,
  }
  return provider
}
