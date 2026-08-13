// Voice AI — smoke test dos workers persistentes de STT/TTS, FORA do
// contexto de uma ligação real. Objetivo: provar, com números, que o
// modelo carrega UMA vez (load_ms alto só na 1ª chamada de aguardarPronto)
// e que requisições subsequentes NÃO recarregam (request_ms cai pra perto
// só do tempo de inferência). Rodar isso ANTES de pedir uma ligação real —
// ver PARTE 9/11 da instrução do endurecimento de latência.
//
// Uso: node scripts/voice/smoke-test-workers.mjs
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..', '..')

process.env.VOICE_PYTHON_BIN = process.env.VOICE_PYTHON_BIN || 'python'
process.env.VOICE_STT_WORKER_SCRIPT_PATH = path.join(ROOT, 'scripts', 'voice', 'stt_worker.py')
process.env.VOICE_TTS_WORKER_SCRIPT_PATH = path.join(ROOT, 'scripts', 'voice', 'tts_worker.py')
process.env.VOICE_TTS_MODEL_PATH = process.env.VOICE_TTS_MODEL_PATH || 'C:\\Users\\msi\\Projeto Claude Code\\voice-models\\pt_BR-faber-medium.onnx'

const { iniciarSttWorker, aguardarSttPronto, transcrever } = await import('../../src/lib/voice/sttBridge.js')
const { iniciarTtsWorker, aguardarTtsPronto, sintetizar } = await import('../../src/lib/voice/ttsBridge.js')

const TMP = path.join(ROOT, '.smoke-test-tmp')
fs.mkdirSync(TMP, { recursive: true })

async function main() {
  console.log('=== subindo STT worker ===')
  iniciarSttWorker()
  const t0stt = Date.now()
  const sttReady = await aguardarSttPronto()
  console.log(`STT_MODEL_READY worker_startup_ms=${Date.now() - t0stt} model_load_once_ms=${sttReady.loadMs}`)

  console.log('=== subindo TTS worker ===')
  iniciarTtsWorker()
  const t0tts = Date.now()
  const ttsReady = await aguardarTtsPronto()
  console.log(`TTS_MODEL_READY worker_startup_ms=${Date.now() - t0tts} model_load_once_ms=${ttsReady.loadMs}`)

  // Gera um WAV de referência (síntese normal) pra usar como entrada das
  // transcrições de teste, evitando depender de um arquivo gravado real.
  const wavReferencia = path.join(TMP, 'referencia.wav')
  await sintetizar('Isto é um teste de latência dos workers persistentes de voz.', wavReferencia)

  console.log('\n=== 3 sínteses consecutivas (TTS) ===')
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now()
    const out = path.join(TMP, `tts-${i}.wav`)
    const r = await sintetizar(`Esta é a síntese de número ${i} para medir latência.`, out)
    console.log(`TTS #${i}: wall_ms=${Date.now() - t0} request_ms=${r.requestMs} synth_ms=${r.synthMs} load_ms=${r.loadMs} via_worker=${r.viaWorker}`)
  }

  console.log('\n=== 3 transcrições consecutivas (STT) ===')
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now()
    const r = await transcrever(wavReferencia)
    console.log(`STT #${i}: wall_ms=${Date.now() - t0} request_ms=${r.requestMs} transcribe_ms=${r.transcribeMs} load_ms=${r.loadMs} via_worker=${r.viaWorker} texto="${r.texto}"`)
  }

  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('\n=== smoke test concluído ===')
  process.exit(0)
}

main().catch((err) => {
  console.error('SMOKE_TEST_FALHOU:', err)
  process.exit(1)
})
