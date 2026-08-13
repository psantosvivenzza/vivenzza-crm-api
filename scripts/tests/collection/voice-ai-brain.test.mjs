// Voice AI MVP — testa o cérebro compartilhado (voiceBrain.js) e as pontes
// STT/TTS reais (sttBridge.js/ttsBridge.js), fora do contexto de chamada
// telefônica (Asterisk não disponível nesta sessão — ver
// scripts/voice/README.md). Prova que voiceBrain.js usa literalmente o
// mesmo intentClassifier/replySuggestion do WhatsApp, nunca um motor
// paralelo, e nunca associa a conta financeira real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')
const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts')

process.env.AI_PROVIDER = 'mock'
process.env.LOCAL_PG_URL = process.env.LOCAL_PG_URL || 'postgres://postgres:localdev_only_2026@127.0.0.1:5433/vivenzza_dev'

test('Voice AI: voiceBrain.js reaproveita o mesmo cérebro do WhatsApp', async (t) => {
  const { responderTurno } = await import('../../../src/lib/voice/voiceBrain.js')

  await t.test('A. "vou pagar sexta" -> PEDIDO_NOVA_DATA, mesma taxonomia do WhatsApp', async () => {
    const r = await responderTurno('vou pagar sexta')
    assert.equal(r.intent, 'PEDIDO_NOVA_DATA')
    assert.ok(r.respostaTexto)
  })

  await t.test('B. "esse valor está errado" -> CONTESTA_VALOR, requiresHuman=true', async () => {
    const r = await responderTurno('esse valor está errado')
    assert.equal(r.intent, 'CONTESTA_VALOR')
    assert.equal(r.requiresHuman, true)
  })

  await t.test('C. "quero falar com alguém" -> QUERO_ATENDENTE, requiresHuman=true', async () => {
    const r = await responderTurno('quero falar com alguém')
    assert.equal(r.intent, 'QUERO_ATENDENTE')
    assert.equal(r.requiresHuman, true)
  })

  await t.test('D. respostaTexto nunca vazio mesmo em erro de geração (fail-safe)', async () => {
    const r = await responderTurno('xyzxyz123 texto sem sentido nenhum')
    assert.ok(typeof r.respostaTexto === 'string' && r.respostaTexto.length > 0)
  })
})

test('Voice AI: pontes STT/TTS reais (faster-whisper/Piper já instalados)', async (t) => {
  const { sintetizar } = await import('../../../src/lib/voice/ttsBridge.js')
  const { transcrever } = await import('../../../src/lib/voice/sttBridge.js')

  process.env.VOICE_PYTHON_BIN = 'python'
  process.env.VOICE_TTS_SCRIPT_PATH = path.join(SCRIPTS, 'voice', 'tts_synthesize.py')
  process.env.VOICE_STT_SCRIPT_PATH = path.join(SCRIPTS, 'voice', 'stt_transcribe.py')
  process.env.VOICE_TTS_MODEL_PATH = 'C:\\Users\\msi\\Projeto Claude Code\\voice-models\\pt_BR-faber-medium.onnx'

  const wavTeste = path.join(__dirname, '..', '..', '..', '.voice-test-tmp.wav')

  await t.test('E. Sintetizar + transcrever de volta (round-trip real, sem mock)', async () => {
    if (!fs.existsSync(process.env.VOICE_TTS_MODEL_PATH)) {
      t.skip('modelo Piper não presente neste ambiente de CI — pulando round-trip real')
      return
    }
    const textoOriginal = 'Bom dia, quero verificar minha situação financeira.'
    const resultadoTts = await sintetizar(textoOriginal, wavTeste)
    assert.ok(resultadoTts.duracaoAudioMs > 0)
    assert.ok(fs.existsSync(wavTeste))

    const resultadoStt = await transcrever(wavTeste)
    assert.ok(resultadoStt.texto.length > 0)
    assert.equal(resultadoStt.idioma, 'pt')

    fs.unlinkSync(wavTeste)
    fs.unlinkSync(wavTeste.replace(/\.wav$/, '.ulaw')) // sintetizar() agora também grava um .ulaw sibling (ver ttsBridge.js)
  })
})

test('Voice AI: prova estática — sem Evolution, sem SQL arbitrário, sem mutação financeira, sem PII em log', () => {
  const arquivos = ['lib/voice/voiceBrain.js', 'lib/voice/sttBridge.js', 'lib/voice/ttsBridge.js', 'lib/voice/ariCallService.js']
  for (const rel of arquivos) {
    const conteudo = fs.readFileSync(path.join(SRC, rel), 'utf8')
    for (const proibido of ['evolutionAdapter', 'evolutionFinanceiro', 'sendText', '.rpc(', 'execute_sql', "from('contas_financeiras')", "from('collection_promises')", "from('collection_dispatches')"]) {
      assert.equal(conteudo.includes(proibido), false, `${rel} não deveria referenciar "${proibido}"`)
    }
  }

  const brain = fs.readFileSync(path.join(SRC, 'lib/voice/voiceBrain.js'), 'utf8')
  assert.equal(brain.includes('collectionContext'), false, 'voiceBrain.js nunca deveria carregar contexto de conta financeira real')
  assert.equal(/contas_financeiras_id/.test(brain), false, 'voiceBrain.js nunca deveria referenciar um id de conta real')

  const service = fs.readFileSync(path.join(SRC, 'lib/voice/ariCallService.js'), 'utf8')
  assert.equal(/console\.log\([^)]*textoTranscrito\)/.test(service), false, 'nunca logar o texto transcrito bruto (pode conter fala do interlocutor)')
})
