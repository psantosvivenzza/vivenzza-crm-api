// Voice AI MVP — ponte STT (faster-whisper via subprocesso Python). Único
// lugar que fala com o script Python. Nunca loga o texto transcrito (pode
// conter fala do interlocutor) — só duração/tempos.
//
// Mesmo achado do ttsBridge.js: Python no Windows não abre arquivo direto
// em \\wsl$\... — o Node copia a gravação (que o Asterisk grava nesse
// caminho UNC) pra um arquivo local temporário antes de chamar o script.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { copyFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

export async function transcrever(wavPath, { idioma = 'pt' } = {}) {
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const sttScript = process.env.VOICE_STT_SCRIPT_PATH
  const sttModel = process.env.VOICE_STT_MODEL || 'small'
  if (!sttScript) throw new Error('VOICE_STT_SCRIPT_PATH não configurado')

  const wavLocalTemp = path.join(tmpdir(), `voice-stt-${randomUUID()}.wav`)
  try {
    await copyFile(wavPath, wavLocalTemp)

    const { stdout } = await execFileAsync(pythonBin, [sttScript, wavLocalTemp, '--model', sttModel, '--lang', idioma], {
      timeout: 30000, maxBuffer: 10 * 1024 * 1024,
    })
    const resultado = JSON.parse(stdout.trim().split('\n').pop())
    return { texto: resultado.texto, idioma: resultado.idioma, loadMs: resultado.load_ms, transcribeMs: resultado.transcribe_ms }
  } finally {
    await unlink(wavLocalTemp).catch(() => {})
  }
}
