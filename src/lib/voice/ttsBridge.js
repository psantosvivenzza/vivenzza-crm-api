// Voice AI — ponte TTS (Piper). Único lugar que fala com o TTS (worker
// persistente OU script avulso).
//
// ACHADO (endurecimento pós-PR #17): o script avulso (tts_synthesize.py)
// recarregava o PiperVoice do ZERO em toda síntese (~2s de load_ms por
// turno). Agora um worker PERSISTENTE (scripts/voice/tts_worker.py) carrega
// o modelo uma vez na subida do serviço — ver pyWorkerClient.js. Se o
// worker não estiver pronto/disponível, cai pro script avulso antigo como
// fallback, sempre logando isso claramente.
//
// ACHADO REAL #1 (homologação da 1ª ligação interna): o Python no Windows
// não consegue abrir arquivo para escrita direto em caminho UNC \\wsl$\... —
// falha com FileNotFoundError mesmo o caminho existindo e sendo gravável.
// Por isso o Python (worker ou script avulso) sempre escreve num arquivo
// LOCAL temporário, e o Node copia pro destino final em \\wsl$\...
//
// ACHADO REAL #2 (mesma homologação): o parser de WAV do Asterisk rejeitava
// o arquivo mesmo em 8kHz/16-bit/mono PCM válido. O Python grava também um
// .ulaw bruto (G.711 mu-law, sem container) ao lado do .wav — o Node copia
// os dois pro destino, e o Asterisk sempre encontra o .ulaw nativamente.
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

export function iniciarTtsWorker() {
  if (worker) return worker
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const scriptPath = process.env.VOICE_TTS_WORKER_SCRIPT_PATH
    || path.join(__dirname, '..', '..', '..', 'scripts', 'voice', 'tts_worker.py')
  const modelo = process.env.VOICE_TTS_MODEL_PATH
  if (!modelo) throw new Error('VOICE_TTS_MODEL_PATH não configurado (necessário pro worker de TTS)')
  worker = criarWorkerPersistente({ label: 'TTS', pythonBin, scriptPath, args: ['--model', modelo] })
  return worker
}

export async function aguardarTtsPronto() {
  return iniciarTtsWorker().aguardarPronto()
}

export function ttsWorkerDisponivel() {
  return worker != null && worker.estaPronto()
}

async function sintetizarViaWorker(texto, wavLocalTemp) {
  const t0 = Date.now()
  const resultado = await worker.enviar({ texto, wav_out: wavLocalTemp })
  return {
    loadMs: 0, synthMs: resultado.synth_ms, duracaoAudioMs: resultado.duracao_audio_ms,
    requestMs: Date.now() - t0, viaWorker: true,
  }
}

async function sintetizarViaSubprocessoAvulso(texto, wavLocalTemp) {
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const ttsScript = process.env.VOICE_TTS_SCRIPT_PATH
  const ttsModel = process.env.VOICE_TTS_MODEL_PATH
  if (!ttsScript) throw new Error('VOICE_TTS_SCRIPT_PATH não configurado (necessário pro fallback sem worker)')

  const t0 = Date.now()
  const args = [ttsScript, texto, wavLocalTemp]
  if (ttsModel) args.push('--model', ttsModel)
  const { stdout } = await execFileAsync(pythonBin, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
  const resultado = JSON.parse(stdout.trim().split('\n').pop())
  return {
    loadMs: resultado.load_ms, synthMs: resultado.synth_ms, duracaoAudioMs: resultado.duracao_audio_ms,
    requestMs: Date.now() - t0, viaWorker: false,
  }
}

export async function sintetizar(texto, wavSaidaPath) {
  const wavLocalTemp = path.join(tmpdir(), `voice-tts-${randomUUID()}.wav`)
  const ulawLocalTemp = wavLocalTemp.replace(/\.wav$/, '.ulaw')
  const ulawSaidaPath = wavSaidaPath.replace(/\.wav$/, '.ulaw')
  try {
    let resultado
    if (worker && worker.estaPronto()) {
      try {
        resultado = await sintetizarViaWorker(texto, wavLocalTemp)
      } catch (err) {
        console.error(`[voice-ai] TTS_WORKER falhou nesta requisição, caindo pro fallback de subprocesso avulso (mais lento): ${err.message}`)
      }
    } else if (worker) {
      console.error(`[voice-ai] TTS_WORKER indisponível (${worker.estaMorto() ? 'morto, excedeu restarts' : 'ainda não pronto'}) — usando fallback de subprocesso avulso (mais lento)`)
    }
    if (!resultado) resultado = await sintetizarViaSubprocessoAvulso(texto, wavLocalTemp)

    await copyFile(wavLocalTemp, wavSaidaPath)
    await copyFile(ulawLocalTemp, ulawSaidaPath)

    return {
      wavPath: wavSaidaPath, ulawPath: ulawSaidaPath,
      loadMs: resultado.loadMs, synthMs: resultado.synthMs, duracaoAudioMs: resultado.duracaoAudioMs,
      requestMs: resultado.requestMs, viaWorker: resultado.viaWorker,
    }
  } finally {
    await unlink(wavLocalTemp).catch(() => {})
    await unlink(ulawLocalTemp).catch(() => {})
  }
}
