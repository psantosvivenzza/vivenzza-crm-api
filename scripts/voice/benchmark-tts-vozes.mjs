// Voice AI MVP — benchmark LOCAL de vozes Piper pt-BR, só pra gerar amostras
// pra escuta humana (não altera config/produção). Gera as MESMAS 4 frases
// em cada voz disponível, salva em scripts/voice/benchmark-output/
// (gitignored) e imprime uma tabela com os tempos/tamanhos/observações.
//
// Uso: node scripts/voice/benchmark-tts-vozes.mjs
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const VOICES_DIR = 'C:\\Users\\msi\\Projeto Claude Code\\voice-models'
const OUTPUT_DIR = path.join(__dirname, 'benchmark-output')
const TTS_SCRIPT = path.join(__dirname, 'tts_synthesize.py')
const PYTHON_BIN = process.env.VOICE_PYTHON_BIN || 'python'

const VOZES = [
  { key: 'faber-medium', modelo: path.join(VOICES_DIR, 'pt_BR-faber-medium.onnx'), observacao: 'REFERÊNCIA — em uso hoje no serviço' },
  { key: 'cadu-medium', modelo: path.join(VOICES_DIR, 'pt_BR-cadu-medium.onnx'), observacao: 'alternativa medium' },
  { key: 'jeff-medium', modelo: path.join(VOICES_DIR, 'pt_BR-jeff-medium.onnx'), observacao: 'alternativa medium' },
  { key: 'edresson-low', modelo: path.join(VOICES_DIR, 'pt_BR-edresson-low.onnx'), observacao: 'qualidade LOW (modelo mais leve/rápido, tende a soar mais robótico)' },
]

const FRASES = [
  { id: '1-saudacao', texto: 'Olá. Este é o assistente virtual da Vivenzza. Como posso ajudar?' },
  { id: '2-feedback', texto: 'Entendi. Só um instante enquanto verifico isso para você.' },
  { id: '3-atendente', texto: 'Claro. Vou encaminhar seu atendimento para uma pessoa da nossa equipe.' },
  { id: '4-nova-data', texto: 'Podemos verificar uma nova data de pagamento para você.' },
]

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true })
  const resultados = []

  for (const voz of VOZES) {
    for (const frase of FRASES) {
      const nomeArquivo = `${voz.key}__${frase.id}.wav`
      const saidaPath = path.join(OUTPUT_DIR, nomeArquivo)
      const t0 = Date.now()
      try {
        const { stdout } = await execFileAsync(
          PYTHON_BIN,
          [TTS_SCRIPT, frase.texto, saidaPath, '--model', voz.modelo],
          { timeout: 30000, maxBuffer: 10 * 1024 * 1024 },
        )
        const resultado = JSON.parse(stdout.trim().split('\n').pop())
        const wallMs = Date.now() - t0
        const info = await stat(saidaPath)
        resultados.push({
          voz: voz.key, frase: frase.id, arquivo: nomeArquivo,
          load_ms: resultado.load_ms, synth_ms: resultado.synth_ms, wall_ms: wallMs,
          duracao_audio_ms: resultado.duracao_audio_ms, tamanho_bytes: info.size,
          compativel_asterisk: 'sim (mesmo pipeline .wav 8kHz + .ulaw já homologado)',
          observacao: voz.observacao,
        })
        console.log(`OK   ${voz.key.padEnd(14)} ${frase.id.padEnd(14)} wall_ms=${wallMs} duracao_ms=${resultado.duracao_audio_ms}`)
      } catch (err) {
        resultados.push({ voz: voz.key, frase: frase.id, arquivo: nomeArquivo, erro: err.message })
        console.error(`FAIL ${voz.key.padEnd(14)} ${frase.id.padEnd(14)} ${err.message}`)
      }
    }
  }

  console.log('\n=== TABELA RESUMO ===')
  console.table(resultados.map((r) => ({
    voz: r.voz, frase: r.frase,
    load_ms: r.load_ms, synth_ms: r.synth_ms, wall_ms: r.wall_ms,
    duracao_audio_ms: r.duracao_audio_ms, tamanho_kb: r.tamanho_bytes ? Math.round(r.tamanho_bytes / 1024) : null,
    erro: r.erro ?? '',
  })))

  console.log(`\nArquivos gerados em: ${OUTPUT_DIR}`)
}

main()
