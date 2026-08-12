// IA WhatsApp MVP — worker local. Roda na máquina do desenvolvedor (onde o
// Ollama está instalado), NUNCA no Railway. Faz só inferência: busca um job
// pronto (prompt já montado pelo backend), chama Ollama 2x (classificação +
// geração), devolve o texto bruto — toda decisão/validação/persistência
// continua no backend (src/lib/collection/ai/workerResult.js).
//
// Uso: npm run ai:worker
// Env obrigatórias: BACKEND_URL, AI_WORKER_TOKEN.
// Env opcionais: OLLAMA_BASE_URL (default http://127.0.0.1:11434),
//   OLLAMA_MODEL (default qwen2.5:7b-instruct), POLL_INTERVAL_MS (default 5000).
import axios from 'axios'

const BACKEND_URL = process.env.BACKEND_URL
const AI_WORKER_TOKEN = process.env.AI_WORKER_TOKEN
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434'
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b-instruct'
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 5000)

if (!BACKEND_URL) throw new Error('ai-worker: BACKEND_URL não configurada.')
if (!AI_WORKER_TOKEN) throw new Error('ai-worker: AI_WORKER_TOKEN não configurado.')

const backend = axios.create({ baseURL: BACKEND_URL, headers: { 'x-ai-worker-token': AI_WORKER_TOKEN }, timeout: 20000 })
const ollama = axios.create({ baseURL: OLLAMA_BASE_URL, timeout: 45000 })

function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function chamarOllama(systemPrompt, mensagemCliente) {
  const { data } = await ollama.post('/api/chat', {
    model: OLLAMA_MODEL,
    stream: false,
    format: 'json',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: mensagemCliente }],
  })
  return data?.message?.content ?? null
}

let encerrando = false
process.on('SIGINT', () => {
  console.log('\n[ai-worker] encerrando após o job atual...')
  encerrando = true
})

async function processarUmJob() {
  const resposta = await backend.get('/api/ai-worker/jobs/next', { validateStatus: (s) => s === 200 || s === 204 })
  if (resposta.status === 204) return false // nada pra fazer agora

  const job = resposta.data
  // Nunca loga o corpo da mensagem — só tamanho, pra não vazar PII no log local.
  console.log(`[ai-worker] job ${job.id} recebido (mensagem: ${job.mensagem_cliente.length} caracteres)`)

  let rawClassify = null
  let rawGenerate = null
  try {
    rawClassify = await chamarOllama(job.classify_system_prompt, job.mensagem_cliente)
    rawGenerate = await chamarOllama(job.generate_system_prompt, job.mensagem_cliente)
  } catch (err) {
    console.error(`[ai-worker] job ${job.id} — erro chamando Ollama: ${err.message}`)
  }

  const resultado = await backend.post(`/api/ai-worker/jobs/${job.id}/result`, {
    raw_classify_response: rawClassify,
    raw_generate_response: rawGenerate,
  })
  console.log(`[ai-worker] job ${job.id} concluído — intent=${resultado.data.intent} requires_human=${resultado.data.requires_human}`)
  return true
}

console.log(`[ai-worker] iniciando — backend=${BACKEND_URL} ollama=${OLLAMA_BASE_URL} modelo=${OLLAMA_MODEL}`)
while (!encerrando) {
  try {
    const processou = await processarUmJob()
    if (!processou) await dormir(POLL_INTERVAL_MS)
  } catch (err) {
    console.error(`[ai-worker] erro no ciclo: ${err.message}`)
    await dormir(POLL_INTERVAL_MS)
  }
}
console.log('[ai-worker] encerrado.')
