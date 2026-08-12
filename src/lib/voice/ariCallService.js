// Voice AI MVP — serviço ARI mínimo, turn-based. Conecta no Asterisk local,
// atende a chamada, toca saudação, grava a fala do interlocutor, transcreve
// (STT), gera resposta (MESMO cérebro do WhatsApp), sintetiza (TTS), toca de
// volta, repete até VOICE_MAX_TURNOS ou até requires_human=true.
//
// AVISO HONESTO: este arquivo segue os padrões documentados da API ARI do
// Asterisk (StasisStart/answer/play/record, eventos PlaybackFinished/
// RecordingFinished) mas NUNCA foi executado contra um Asterisk real nesta
// sessão — não havia WSL2/Docker disponíveis pra rodar o Asterisk. As peças
// de STT/cérebro/TTS (sttBridge.js/voiceBrain.js/ttsBridge.js) FORAM
// testadas de ponta a ponta fora do contexto de chamada (ver
// scripts/voice/README.md); só a integração ARI em si é código preparado,
// não homologado.
import AriClient from 'ari-client'
import path from 'node:path'
import { transcrever } from './sttBridge.js'
import { sintetizar } from './ttsBridge.js'
import { responderTurno } from './voiceBrain.js'

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088'
const ARI_USER = process.env.ARI_USER
const ARI_PASSWORD = process.env.ARI_PASSWORD
const ARI_APP = process.env.ARI_APP || 'vivenzza-voice-ai'
const SOUNDS_DIR = process.env.ASTERISK_SOUNDS_DIR
const RECORDINGS_DIR = process.env.ASTERISK_RECORDINGS_DIR
const MAX_TURNOS = Number(process.env.VOICE_MAX_TURNOS || 4)

const SAUDACAO = 'Olá. Este é um teste interno do assistente de voz da Vivenzza. Como posso ajudar?'

export async function iniciarServicoVoz() {
  if (!ARI_USER || !ARI_PASSWORD) throw new Error('ARI_USER/ARI_PASSWORD não configurados (env local, nunca commitados)')
  if (!SOUNDS_DIR || !RECORDINGS_DIR) throw new Error('ASTERISK_SOUNDS_DIR/ASTERISK_RECORDINGS_DIR não configurados')

  const client = await AriClient.connect(ARI_URL, ARI_USER, ARI_PASSWORD)

  client.on('StasisStart', async (event, channel) => {
    console.log(`[voice-ai] chamada iniciada: ${channel.id}`)
    try {
      await conduzirChamada(client, channel)
    } catch (err) {
      console.error(`[voice-ai] erro na chamada ${channel.id}: ${err.message}`)
    } finally {
      try {
        await channel.hangup()
      } catch {
        // já pode ter desligado do outro lado — ignora
      }
    }
  })

  client.start(ARI_APP)
  console.log(`[voice-ai] conectado ao ARI (${ARI_URL}), app="${ARI_APP}", aguardando chamadas...`)
  return client
}

async function conduzirChamada(client, channel) {
  await channel.answer()

  const nomeArquivoSaudacao = `voice-ai-${channel.id}-saudacao`
  await sintetizar(SAUDACAO, path.join(SOUNDS_DIR, `${nomeArquivoSaudacao}.wav`))
  await tocarEEsperar(channel, `custom/${nomeArquivoSaudacao}`)

  for (let turno = 1; turno <= MAX_TURNOS; turno++) {
    const nomeGravacao = `voice-ai-${channel.id}-turno${turno}`
    const gravacao = await channel.record({
      name: nomeGravacao, format: 'wav', maxDurationSeconds: 15, maxSilenceSeconds: 2, terminateOn: '#',
    })
    await esperarGravacaoConcluir(client, gravacao)

    const wavGravado = path.join(RECORDINGS_DIR, `${nomeGravacao}.wav`)
    const { texto: textoTranscrito, transcribeMs } = await transcrever(wavGravado)
    console.log(`[voice-ai] turno ${turno} — STT ${transcribeMs}ms, ${textoTranscrito.length} caracteres transcritos`)

    if (!textoTranscrito.trim()) {
      console.log(`[voice-ai] turno ${turno} — silêncio/sem fala detectada, encerrando`)
      break
    }

    const t0brain = Date.now()
    const resultado = await responderTurno(textoTranscrito)
    const brainMs = Date.now() - t0brain
    console.log(`[voice-ai] turno ${turno} — IA ${brainMs}ms, intent=${resultado.intent}, requiresHuman=${resultado.requiresHuman}`)

    const nomeResposta = `voice-ai-${channel.id}-resposta${turno}`
    await sintetizar(resultado.respostaTexto, path.join(SOUNDS_DIR, `${nomeResposta}.wav`))
    await tocarEEsperar(channel, `custom/${nomeResposta}`)

    if (resultado.requiresHuman) {
      console.log(`[voice-ai] turno ${turno} — requires_human=true, encerrando o loop de IA (transferência real pra humano é passo futuro, não implementado)`)
      break
    }
  }
}

function tocarEEsperar(channel, media) {
  return new Promise((resolve, reject) => {
    channel.play({ media: `sound:${media}` }, (err, playback) => {
      if (err) return reject(err)
      const timeoutId = setTimeout(() => {
        channel.removeListener('PlaybackFinished', onFinished)
        resolve()
      }, 15000)
      function onFinished(event, pb) {
        if (pb.id !== playback.id) return
        clearTimeout(timeoutId)
        channel.removeListener('PlaybackFinished', onFinished)
        resolve()
      }
      channel.on('PlaybackFinished', onFinished)
    })
  })
}

function esperarGravacaoConcluir(client, gravacao) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      client.removeListener('RecordingFinished', onFinished)
      resolve()
    }, 20000)
    function onFinished(event, rec) {
      if (rec.name !== gravacao.name) return
      clearTimeout(timeoutId)
      client.removeListener('RecordingFinished', onFinished)
      resolve()
    }
    client.on('RecordingFinished', onFinished)
  })
}
