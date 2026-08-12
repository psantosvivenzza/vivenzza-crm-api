// IA WhatsApp MVP — API do worker local (Ollama roda fora do Railway).
// Protegida por AI_WORKER_TOKEN (aiWorkerAuth.js), nunca pelo JWT de usuário
// comum. Nenhum endpoint aqui envia WhatsApp, executa SQL arbitrário, ou dá
// acesso a segredo algum — o worker só troca prompt/resultado de inferência.
import { Router } from 'express'
import { proximoJobDisponivel, buscarJob } from '../lib/collection/ai/jobQueue.js'
import { aplicarResultadoDoWorker } from '../lib/collection/ai/workerResult.js'

const router = Router()

// GET /api/ai-worker/jobs/next — arrenda o job pendente mais antigo (ou um
// job travado cujo lease expirou). Devolve só o necessário pra inferência:
// prompts já prontos + o texto da mensagem do cliente. Nunca devolve
// telefone completo em log — o worker é responsável por não logar o corpo.
router.get('/jobs/next', async (req, res) => {
  try {
    const job = await proximoJobDisponivel()
    if (!job) return res.status(204).end()
    res.json({
      id: job.id,
      mensagem_cliente: job.mensagem_cliente,
      classify_system_prompt: job.classify_system_prompt,
      generate_system_prompt: job.generate_system_prompt,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/ai-worker/jobs/:id/result — recebe o TEXTO BRUTO devolvido pelo
// modelo (nunca confia nele) e delega toda validação/guardrail/persistência
// pro mesmo caminho da chamada direta (workerResult.js -> montarSugestaoFinal).
router.post('/jobs/:id/result', async (req, res) => {
  try {
    const job = await buscarJob(req.params.id)
    if (!job) return res.status(404).json({ erro: 'Job não encontrado' })
    if (job.status === 'done') return res.status(409).json({ erro: 'Job já concluído' })

    const { raw_classify_response, raw_generate_response } = req.body || {}
    const registro = await aplicarResultadoDoWorker(job, {
      rawClassifyResponse: raw_classify_response ?? null,
      rawGenerateResponse: raw_generate_response ?? null,
    })
    res.json({ suggestion_id: registro.id, intent: registro.intent, requires_human: registro.requires_human })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
