// Voice AI MVP — ponte TTS (Piper via subprocesso Python). Único lugar que
// fala com o script Python. Escreve o WAV sintetizado direto no diretório
// configurado (ex: pasta de sounds do Asterisk) — quem decide o caminho de
// saída é o chamador, nunca hardcoded aqui.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

// Env lidas dentro da função (não como const de módulo) de propósito — ver
// mesma nota em sttBridge.js.
export async function sintetizar(texto, wavSaidaPath) {
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const ttsScript = process.env.VOICE_TTS_SCRIPT_PATH
  const ttsModel = process.env.VOICE_TTS_MODEL_PATH
  if (!ttsScript) throw new Error('VOICE_TTS_SCRIPT_PATH não configurado')

  const args = [ttsScript, texto, wavSaidaPath]
  if (ttsModel) args.push('--model', ttsModel)
  const { stdout } = await execFileAsync(pythonBin, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
  const resultado = JSON.parse(stdout.trim().split('\n').pop())
  return { wavPath: resultado.wav_path, loadMs: resultado.load_ms, synthMs: resultado.synth_ms, duracaoAudioMs: resultado.duracao_audio_ms }
}
