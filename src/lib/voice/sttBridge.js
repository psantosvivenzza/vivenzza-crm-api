// Voice AI — ponte STT (faster-whisper). Único lugar que fala com o
// STT (worker persistente OU script avulso). Nunca loga o texto transcrito
// (pode conter fala do interlocutor) — só duração/tempos.
//
// ACHADO (endurecimento pós-PR #17): o script avulso (stt_transcribe.py)
// recarregava o WhisperModel do ZERO em toda transcrição (~2.3s de
// load_ms por turno). Agora um worker PERSISTENTE (scripts/voice/
// stt_worker.py) carrega o modelo uma vez na subida do serviço e fica
// respondendo via stdin/stdout — ver pyWorkerClient.js. Se o worker não
// estiver pronto/disponível (ainda subindo, morreu e excedeu o limite de
// restart), cai pro script avulso antigo como fallback, sempre logando
// isso claramente — nunca mascara a degradação em silêncio.
//
// Mesmo achado do ttsBridge.js: Python no Windows não abre arquivo direto
// em \\wsl$\... — o Node copia a gravação (que o Asterisk grava nesse
// caminho UNC) pra um arquivo local temporário antes de chamar o Python
// (worker ou script avulso).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { copyFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { criarWorkerPersistente } from './pyWorkerClient.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

let worker = null

export function iniciarSttWorker() {
  if (worker) return worker
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const scriptPath = process.env.VOICE_STT_WORKER_SCRIPT_PATH
    || path.join(__dirname, '..', '..', '..', 'scripts', 'voice', 'stt_worker.py')
  const modelo = process.env.VOICE_STT_MODEL || 'small'
  worker = criarWorkerPersistente({ label: 'STT', pythonBin, scriptPath, args: ['--model', modelo] })
  return worker
}

export async function aguardarSttPronto() {
  return iniciarSttWorker().aguardarPronto()
}

export function sttWorkerDisponivel() {
  return worker != null && worker.estaPronto()
}

async function transcreverViaWorker(wavLocalTemp, idioma) {
  const t0 = Date.now()
  const resultado = await worker.enviar({ wav_path: wavLocalTemp, lang: idioma })
  return {
    texto: resultado.texto, idioma: resultado.idioma,
    loadMs: 0, transcribeMs: resultado.transcribe_ms, requestMs: Date.now() - t0, viaWorker: true,
  }
}

async function transcreverViaSubprocessoAvulso(wavLocalTemp, idioma) {
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const sttScript = process.env.VOICE_STT_SCRIPT_PATH
  const sttModel = process.env.VOICE_STT_MODEL || 'small'
  if (!sttScript) throw new Error('VOICE_STT_SCRIPT_PATH não configurado (necessário pro fallback sem worker)')

  const t0 = Date.now()
  const { stdout } = await execFileAsync(pythonBin, [sttScript, wavLocalTemp, '--model', sttModel, '--lang', idioma], {
    timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  })
  const resultado = JSON.parse(stdout.trim().split('\n').pop())
  return {
    texto: resultado.texto, idioma: resultado.idioma,
    loadMs: resultado.load_ms, transcribeMs: resultado.transcribe_ms, requestMs: Date.now() - t0, viaWorker: false,
  }
}

export async function transcrever(wavPath, { idioma = 'pt' } = {}) {
  const wavLocalTemp = path.join(tmpdir(), `voice-stt-${randomUUID()}.wav`)
  try {
    await copyFile(wavPath, wavLocalTemp)

    if (worker && worker.estaPronto()) {
      try {
        return await transcreverViaWorker(wavLocalTemp, idioma)
      } catch (err) {
        console.error(`[voice-ai] STT_WORKER falhou nesta requisição, caindo pro fallback de subprocesso avulso (mais lento): ${err.message}`)
      }
    } else if (worker) {
      console.error(`[voice-ai] STT_WORKER indisponível (${worker.estaMorto() ? 'morto, excedeu restarts' : 'ainda não pronto'}) — usando fallback de subprocesso avulso (mais lento)`)
    }

    return await transcreverViaSubprocessoAvulso(wavLocalTemp, idioma)
  } finally {
    await unlink(wavLocalTemp).catch(() => {})
  }
}
