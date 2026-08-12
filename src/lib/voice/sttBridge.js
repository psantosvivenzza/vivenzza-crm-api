// Voice AI MVP — ponte STT (faster-whisper via subprocesso Python). Único
// lugar que fala com o script Python — mesmo padrão de isolamento já usado
// por outros adapters externos deste projeto. Nunca loga o texto transcrito
// (pode conter fala do interlocutor) — só duração/tempos.
//
// Env lidas dentro da função (não como const de módulo) de propósito — permite
// configurar/injetar em testes depois do import, sem cache stale.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function transcrever(wavPath, { idioma = 'pt' } = {}) {
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const sttScript = process.env.VOICE_STT_SCRIPT_PATH
  const sttModel = process.env.VOICE_STT_MODEL || 'small'
  if (!sttScript) throw new Error('VOICE_STT_SCRIPT_PATH não configurado')

  const { stdout } = await execFileAsync(pythonBin, [sttScript, wavPath, '--model', sttModel, '--lang', idioma], {
    timeout: 30000, maxBuffer: 10 * 1024 * 1024,
  })
  const resultado = JSON.parse(stdout.trim().split('\n').pop())
  return { texto: resultado.texto, idioma: resultado.idioma, loadMs: resultado.load_ms, transcribeMs: resultado.transcribe_ms }
}
