// Voice AI MVP — ponte TTS (Piper via subprocesso Python). Único lugar que
// fala com o script Python.
//
// ACHADO REAL #1 (homologação da 1ª ligação interna): o Python no Windows
// não consegue abrir arquivo para escrita direto em caminho UNC \\wsl$\... —
// falha com FileNotFoundError mesmo o caminho existindo e sendo gravável
// (confirmado: o mesmo caminho é gravável via fs do Node e via bash, só a
// I/O de arquivo do CPython no Windows não resolve esse provedor de rede
// específico). Por isso o Python sempre escreve num arquivo LOCAL
// temporário, e o Node (que já provou conseguir escrever em \\wsl$\...)
// copia pro destino final — sem precisar reinstalar nada.
//
// ACHADO REAL #2 (mesma homologação, confirmado no log do Asterisk): o
// parser de WAV do Asterisk rejeitava o arquivo mesmo em 8kHz/16-bit/mono
// PCM válido ("File ... does not exist in any format"). tts_synthesize.py
// agora grava também um .ulaw bruto (G.711 mu-law, sem container) ao lado
// do .wav — o Node copia os dois pro destino, e o Asterisk sempre encontra
// o .ulaw nativamente, sem depender do parser de WAV.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { copyFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

// Env lidas dentro da função (não como const de módulo) de propósito — ver
// mesma nota em sttBridge.js.
export async function sintetizar(texto, wavSaidaPath) {
  const pythonBin = process.env.VOICE_PYTHON_BIN || 'python'
  const ttsScript = process.env.VOICE_TTS_SCRIPT_PATH
  const ttsModel = process.env.VOICE_TTS_MODEL_PATH
  if (!ttsScript) throw new Error('VOICE_TTS_SCRIPT_PATH não configurado')

  const wavLocalTemp = path.join(tmpdir(), `voice-tts-${randomUUID()}.wav`)
  const ulawLocalTemp = wavLocalTemp.replace(/\.wav$/, '.ulaw')
  const ulawSaidaPath = wavSaidaPath.replace(/\.wav$/, '.ulaw')
  try {
    const args = [ttsScript, texto, wavLocalTemp]
    if (ttsModel) args.push('--model', ttsModel)
    const { stdout } = await execFileAsync(pythonBin, args, { timeout: 30000, maxBuffer: 10 * 1024 * 1024 })
    const resultado = JSON.parse(stdout.trim().split('\n').pop())

    await copyFile(wavLocalTemp, wavSaidaPath)
    await copyFile(ulawLocalTemp, ulawSaidaPath)

    return {
      wavPath: wavSaidaPath, ulawPath: ulawSaidaPath,
      loadMs: resultado.load_ms, synthMs: resultado.synth_ms, duracaoAudioMs: resultado.duracao_audio_ms,
    }
  } finally {
    await unlink(wavLocalTemp).catch(() => {})
    await unlink(ulawLocalTemp).catch(() => {})
  }
}
