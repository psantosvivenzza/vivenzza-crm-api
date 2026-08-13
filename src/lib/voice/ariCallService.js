// Voice AI MVP — serviço ARI turn-based. Homologado num teste isolado com
// tone:ring (sem TTS/Python) confirmando: StasisStart -> answer -> playback
// -> canal permanece vivo, SIP/PJSIP/dialplan/ARI 100% OK. Este arquivo
// agora adiciona o turno completo (captura de fala -> STT -> mesmo cérebro
// do WhatsApp -> TTS -> playback) sobre essa base já provada, mantendo toda
// a instrumentação e o tratamento de exceção por turno (uma falha de mídia
// nunca deve derrubar a ligação sem log).
import AriClient from 'ari-client'
import path from 'node:path'
import { transcrever } from './sttBridge.js'
import { sintetizar } from './ttsBridge.js'
import { responderTurno, aquecerCerebro } from './voiceBrain.js'
import { inspecionarWav } from './wavInspector.js'

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088'
const ARI_USER = process.env.ARI_USER
const ARI_PASSWORD = process.env.ARI_PASSWORD
const ARI_APP = process.env.ARI_APP || 'vivenzza-voice-ai'
const SOUNDS_DIR = process.env.ASTERISK_SOUNDS_DIR
const RECORDINGS_DIR = process.env.ASTERISK_RECORDINGS_DIR
const MAX_TURNOS = Number(process.env.VOICE_MAX_TURNOS || 2)
const RECORD_MAX_DURATION_S = Number(process.env.VOICE_RECORD_MAX_DURATION_S || 8)
// ACHADO (otimização de latência): a API ARI de record (maxSilenceSeconds)
// só aceita INTEIRO de segundos — 800ms pedido não é expressável sem VAD
// (Silero, fora de escopo agora). 1s é o mínimo granular disponível hoje.
const RECORD_MAX_SILENCE_S = Number(process.env.VOICE_RECORD_MAX_SILENCE_S || 1)

const SAUDACAO = 'Olá. Este é um teste interno do assistente de voz da Vivenzza. Pode falar depois do sinal.'
const NOME_SAUDACAO_FIXA = 'voice-ai-saudacao-fixa'
const FEEDBACK_IMEDIATO = 'Só um instante enquanto verifico isso.'
const NOME_FEEDBACK_FIXO = 'voice-ai-feedback-fixo'

// ACHADO REAL (homologação): sintetizar a saudação/feedback NO MOMENTO da
// chamada cria segundos de silêncio total antes de qualquer áudio —
// silêncio grande o bastante pra o interlocutor humano desligar. Textos
// fixos, sintetizados UMA VEZ na subida do serviço, não por chamada.
let saudacaoFixa = null // { media, duracaoMs }
let feedbackFixo = null // { media, duracaoMs }

export async function iniciarServicoVoz() {
  if (!ARI_USER || !ARI_PASSWORD) throw new Error('ARI_USER/ARI_PASSWORD não configurados (env local, nunca commitados)')
  if (!SOUNDS_DIR || !RECORDINGS_DIR) throw new Error('ASTERISK_SOUNDS_DIR/ASTERISK_RECORDINGS_DIR não configurados')

  try {
    const t0 = Date.now()
    const resultado = await sintetizar(SAUDACAO, path.join(SOUNDS_DIR, `${NOME_SAUDACAO_FIXA}.wav`))
    saudacaoFixa = { media: `custom/${NOME_SAUDACAO_FIXA}`, duracaoMs: resultado.duracaoAudioMs }
    console.log(`[voice-ai] saudação pré-gerada na subida do serviço, TTS_ms=${Date.now() - t0} duracaoMs=${resultado.duracaoAudioMs}`)
  } catch (err) {
    console.error(`[voice-ai] falha ao pré-gerar saudação (vai cair pro fallback tone:ring em toda chamada): ${err.message}`)
  }

  try {
    const t0 = Date.now()
    const resultado = await sintetizar(FEEDBACK_IMEDIATO, path.join(SOUNDS_DIR, `${NOME_FEEDBACK_FIXO}.wav`))
    feedbackFixo = { media: `custom/${NOME_FEEDBACK_FIXO}`, duracaoMs: resultado.duracaoAudioMs }
    console.log(`[voice-ai] feedback imediato pré-gerado na subida do serviço, TTS_ms=${Date.now() - t0} duracaoMs=${resultado.duracaoAudioMs}`)
  } catch (err) {
    console.error(`[voice-ai] falha ao pré-gerar feedback imediato (turno seguirá sem ele, sem travar): ${err.message}`)
  }

  try {
    const t0 = Date.now()
    await aquecerCerebro()
    console.log(`[voice-ai] cérebro (Ollama) aquecido na subida do serviço, warmup_ms=${Date.now() - t0}`)
  } catch (err) {
    console.error(`[voice-ai] falha ao aquecer o cérebro (1ª chamada real pode ficar mais lenta): ${err.message}`)
  }

  const client = await AriClient.connect(ARI_URL, ARI_USER, ARI_PASSWORD)

  client.on('StasisStart', async (event, channel) => {
    console.log(`[voice-ai] StasisStart channel=${channel.id}`)
    instrumentarCanal(channel)

    try {
      console.log(`[voice-ai] answer() channel=${channel.id}`)
      await channel.answer()
      console.log(`[voice-ai] answer() OK channel=${channel.id}`)

      await tocarComFallback(channel, async () => {
        if (!saudacaoFixa) throw new Error('saudação pré-gerada indisponível')
        return saudacaoFixa
      }, 'saudação')

      let turno = 1
      let ultimoRequiresHuman = false
      for (; turno <= MAX_TURNOS; turno++) {
        console.log(`[voice-ai] === turno ${turno}/${MAX_TURNOS} channel=${channel.id} ===`)
        const continuar = await executarTurno(client, channel, turno)
        if (!continuar.ok) {
          console.log(`[voice-ai] turno ${turno} não produziu diálogo válido (${continuar.motivo}) — encerrando`)
          break
        }
        ultimoRequiresHuman = continuar.requiresHuman
        if (continuar.requiresHuman) {
          console.log(`[voice-ai] turno ${turno} — requires_human=true, encerrando loop de IA (transferência real pra humano é passo futuro)`)
          break
        }
      }
      console.log(`[voice-ai] fim do loop de turnos channel=${channel.id} ultimoRequiresHuman=${ultimoRequiresHuman}`)
    } catch (err) {
      console.error(`[voice-ai] EXCEÇÃO não tratada no ciclo da chamada channel=${channel.id}: ${err.message}`)
      console.error(err.stack)
    } finally {
      try {
        await channel.hangup()
        console.log(`[voice-ai] hangup() explícito OK channel=${channel.id}`)
      } catch (e) {
        console.log(`[voice-ai] hangup() explícito falhou (provavelmente já desligado) channel=${channel.id}: ${e.message}`)
      }
    }
  })

  client.start(ARI_APP)
  console.log(`[voice-ai] conectado ao ARI (${ARI_URL}), app="${ARI_APP}", aguardando chamadas...`)
  return client
}

function instrumentarCanal(channel) {
  channel.on('ChannelStateChange', (ev, ch) => console.log(`[voice-ai] ChannelStateChange channel=${ch.id} state=${ch.state}`))
  channel.on('ChannelHangupRequest', (ev, ch) => console.log(`[voice-ai] ChannelHangupRequest channel=${ch.id} cause=${ev.cause} soft=${ev.soft}`))
  channel.on('ChannelDestroyed', (ev, ch) => console.log(`[voice-ai] ChannelDestroyed channel=${ch.id} cause=${ev.cause} cause_txt="${ev.cause_txt}"`))
  channel.on('StasisEnd', (ev, ch) => console.log(`[voice-ai] StasisEnd channel=${ch.id}`))
  channel.on('PlaybackStarted', (ev, pb) => console.log(`[voice-ai] PlaybackStarted id=${pb.id} media_uri=${pb.media_uri}`))
  channel.on('PlaybackFinished', (ev, pb) => console.log(`[voice-ai] PlaybackFinished id=${pb.id}`))
  channel.on('PlaybackFailed', (ev, pb) => console.log(`[voice-ai] PlaybackFailed id=${pb?.id}`))
}

// ACHADO REAL (homologação): PlaybackFinished NUNCA chega neste ari-client
// (confirmado inclusive no teste isolado de tone:ring que funcionou de
// verdade — o áudio tocou mas o evento nunca disparou). Esperar esse evento
// significava até 20s de silêncio morto depois de CADA áudio, silêncio
// grande o bastante pra o interlocutor desligar antes do próximo passo.
// Como já sabemos a duração exata do áudio gerado (Piper devolve isso),
// usamos ela como cronômetro determinístico em vez de depender do evento —
// só cai no timeout de segurança (bem mais curto) se a duração não for
// conhecida (fallback tone:ring).
const ESPERA_PLAYBACK_BUFFER_MS = 800
const ESPERA_PLAYBACK_SEM_DURACAO_MS = 2500

// Nunca deixa a ligação cair por falha de mídia — se o TTS falhar, cai pro
// tom nativo do Asterisk (tone:ring, já homologado isoladamente), sempre
// logando a causa real. `gerarMedia` retorna { media, duracaoMs } quando
// souber a duração real do áudio.
async function tocarComFallback(channel, gerarMedia, rotulo) {
  let media = null
  let duracaoMs = null
  try {
    const resultado = await gerarMedia()
    media = resultado.media
    duracaoMs = resultado.duracaoMs
  } catch (err) {
    console.error(`[voice-ai] falha gerando mídia (${rotulo}) channel=${channel.id}: ${err.message} — usando fallback tone:ring`)
    media = null
  }

  const mediaUri = media ? `sound:${media}` : 'tone:ring'
  console.log(`[voice-ai] PLAYBACK_REQUESTED (${rotulo}) media=${mediaUri} duracaoMs=${duracaoMs ?? 'desconhecida'} channel=${channel.id}`)
  try {
    const playback = await new Promise((resolve, reject) => {
      channel.play({ media: mediaUri }, (err, pb) => (err ? reject(err) : resolve(pb)))
    })
    await esperarPlaybackFinalizar(channel, playback, duracaoMs)
  } catch (err) {
    console.error(`[voice-ai] falha no playback (${rotulo}) channel=${channel.id}: ${err.message} — seguindo sem travar a ligação`)
  }
}

// Toca sem esperar terminar — usado só pro feedback imediato ("só um
// instante..."), que precisa começar a tocar o quanto antes e deixar
// STT/LLM/TTS rodando "por cima" (Asterisk enfileira o próximo play depois
// que este acabar, então a resposta real só toca depois do feedback, nunca
// simultaneamente).
function tocarSemEsperar(channel, media, rotulo) {
  if (!media) return
  try {
    channel.play({ media: `sound:${media}` }, (err) => {
      if (err) console.error(`[voice-ai] falha tocando (${rotulo}, não bloqueante) channel=${channel.id}: ${err.message}`)
    })
    console.log(`[voice-ai] PLAYBACK_REQUESTED (${rotulo}, não bloqueante) media=sound:${media} channel=${channel.id}`)
  } catch (err) {
    console.error(`[voice-ai] falha síncrona tocando (${rotulo}) channel=${channel.id}: ${err.message}`)
  }
}

function esperarPlaybackFinalizar(channel, playback, duracaoMs) {
  const esperaMaximaMs = duracaoMs != null ? duracaoMs + ESPERA_PLAYBACK_BUFFER_MS : ESPERA_PLAYBACK_SEM_DURACAO_MS
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log(`[voice-ai] fim da espera de playback (${esperaMaximaMs}ms, ${duracaoMs != null ? 'duração conhecida' : 'sem duração — fallback curto'}) id=${playback.id} channel=${channel.id}`)
      resolve()
    }, esperaMaximaMs)
    function onFinished(ev, pb) {
      if (pb.id !== playback.id) return
      clearTimeout(timeoutId)
      channel.removeListener('PlaybackFinished', onFinished)
      resolve()
    }
    channel.on('PlaybackFinished', onFinished)
  })
}

// Executa 1 turno completo: grava -> valida -> STT -> cérebro -> TTS ->
// playback. Nunca lança pra fora — qualquer falha vira {ok:false, motivo}.
async function executarTurno(client, channel, numeroTurno) {
  const nomeGravacao = `voice-ai-${channel.id}-turno${numeroTurno}`
  try {
    console.log(`[voice-ai] RECORD_STARTED turno=${numeroTurno} channel=${channel.id}`)
    const tCapture0 = Date.now()
    const gravacao = await new Promise((resolve, reject) => {
      channel.record({
        name: nomeGravacao, format: 'wav', maxDurationSeconds: RECORD_MAX_DURATION_S,
        maxSilenceSeconds: RECORD_MAX_SILENCE_S, terminateOn: 'none', beep: true, ifExists: 'overwrite',
      }, (err, rec) => (err ? reject(err) : resolve(rec)))
    })
    await esperarGravacaoConcluir(client, gravacao)
    const captureMs = Date.now() - tCapture0
    console.log(`[voice-ai] RECORD_FINISHED turno=${numeroTurno} capture_ms=${captureMs} channel=${channel.id}`)

    const tInspect0 = Date.now()
    const wavGravado = path.join(RECORDINGS_DIR, `${nomeGravacao}.wav`)
    let inspecao
    try {
      inspecao = inspecionarWav(wavGravado)
    } catch (err) {
      console.error(`[voice-ai] arquivo de gravação não encontrado/ilegível turno=${numeroTurno}: ${err.message}`)
      return { ok: false, motivo: 'arquivo_gravacao_ausente' }
    }
    const wavInspectMs = Date.now() - tInspect0
    console.log(`[voice-ai] WAV_INSPECAO turno=${numeroTurno} wav_inspect_ms=${wavInspectMs} tamanhoBytes=${inspecao.tamanhoBytes} sampleRate=${inspecao.sampleRate} canais=${inspecao.numChannels} bits=${inspecao.bitsPerSample} duracaoMs=${inspecao.duracaoMs} valido=${inspecao.valido}`)
    if (!inspecao.valido) {
      console.log(`[voice-ai] gravação inválida turno=${numeroTurno}: ${inspecao.motivo} — nada foi dito ou silêncio total`)
      return { ok: false, motivo: `gravacao_invalida: ${inspecao.motivo}` }
    }

    // Feedback imediato, NÃO bloqueante — dispara e segue pro STT/LLM/TTS
    // "por cima" dele, em vez de ficar em silêncio pelos ~14s que o
    // processamento completo leva.
    const tPosRecord = Date.now()
    tocarSemEsperar(channel, feedbackFixo?.media, 'feedback-imediato')
    const timeToFeedbackMs = Date.now() - tPosRecord
    console.log(`[voice-ai] time_to_feedback_ms=${timeToFeedbackMs} turno=${numeroTurno}`)

    // ACHADO (PARTE C — instrumentação de latência): antes, STT_ms logava só
    // o `transcribe_ms` que o Python devolve (tempo interno do
    // whisper.transcribe(), sem contar load_ms do modelo, cópia do arquivo
    // pra temp local, spawn do processo Python nem o parse do JSON). Isso
    // escondia um pedaço real de latência dentro do "gap não explicado"
    // entre a soma dos estágios e o time_to_real_reply_ms medido. Agora
    // stt_wall_ms mede o tempo de parede real (Date.now() ao redor da
    // chamada inteira a transcrever()), e loga junto o breakdown interno
    // (load/transcribe) pra deixar claro quanto é overhead de bridge vs.
    // motor de fato.
    console.log(`[voice-ai] STT_STARTED turno=${numeroTurno} channel=${channel.id}`)
    const tStt0 = Date.now()
    const { texto: transcript, transcribeMs, loadMs: sttLoadMs } = await transcrever(wavGravado)
    const sttWallMs = Date.now() - tStt0
    const sttBridgeOverheadMs = sttWallMs - (transcribeMs ?? 0) - (sttLoadMs ?? 0)
    console.log(`[voice-ai] STT_FINISHED turno=${numeroTurno} stt_wall_ms=${sttWallMs} stt_load_ms=${sttLoadMs} stt_transcribe_ms=${transcribeMs} stt_bridge_overhead_ms=${sttBridgeOverheadMs} caracteres=${transcript.length}`)
    // HOMOLOGAÇÃO INTERNAL_TEST (voz do próprio operador, não cliente real) —
    // log verboso do transcript só nesta fase de diagnóstico controlado,
    // nunca em produção real (ver nota equivalente em replySuggestion.js).
    console.log(`[voice-ai] TRANSCRIPT turno=${numeroTurno}: "${transcript}"`)

    if (!transcript.trim()) {
      console.log(`[voice-ai] transcript vazio turno=${numeroTurno} — nada reconhecido, encerrando sem travar`)
      return { ok: false, motivo: 'transcript_vazio' }
    }

    console.log(`[voice-ai] LLM_STARTED turno=${numeroTurno} channel=${channel.id}`)
    const tLlm0 = Date.now()
    const resultado = await responderTurno(transcript)
    const llmMs = Date.now() - tLlm0
    console.log(`[voice-ai] LLM_FINISHED turno=${numeroTurno} LLM_ms=${llmMs} intent=${resultado.intent} requiresHuman=${resultado.requiresHuman}`)

    const nomeResposta = `voice-ai-${channel.id}-resposta${numeroTurno}`
    let ttsWallMs = 0
    let ttsLoadMs = null
    let ttsSynthMs = null
    await tocarComFallback(channel, async () => {
      const t0tts = Date.now()
      const wavResposta = path.join(SOUNDS_DIR, `${nomeResposta}.wav`)
      const resultadoTts = await sintetizar(resultado.respostaTexto, wavResposta)
      ttsWallMs = Date.now() - t0tts
      ttsLoadMs = resultadoTts.loadMs
      ttsSynthMs = resultadoTts.synthMs
      const ttsBridgeOverheadMs = ttsWallMs - (ttsSynthMs ?? 0) - (ttsLoadMs ?? 0)
      console.log(`[voice-ai] TTS_FINISHED turno=${numeroTurno} tts_wall_ms=${ttsWallMs} tts_load_ms=${ttsLoadMs} tts_synth_ms=${ttsSynthMs} tts_bridge_overhead_ms=${ttsBridgeOverheadMs} duracaoMs=${resultadoTts.duracaoAudioMs}`)
      return { media: `custom/${nomeResposta}`, duracaoMs: resultadoTts.duracaoAudioMs }
    }, `resposta-turno${numeroTurno}`)

    const timeToRealReplyMs = Date.now() - tPosRecord
    const somaEstagiosMs = wavInspectMs + sttWallMs + llmMs + ttsWallMs
    const overheadNaoExplicadoMs = timeToRealReplyMs - somaEstagiosMs
    console.log(`[voice-ai] LATENCIA_RESUMO turno=${numeroTurno} time_to_feedback_ms=${timeToFeedbackMs} wav_inspect_ms=${wavInspectMs} stt_wall_ms=${sttWallMs} llm_ms=${llmMs} tts_wall_ms=${ttsWallMs} soma_estagios_ms=${somaEstagiosMs} time_to_real_reply_ms=${timeToRealReplyMs} overhead_nao_explicado_ms=${overheadNaoExplicadoMs}`)

    return { ok: true, requiresHuman: resultado.requiresHuman, intent: resultado.intent }
  } catch (err) {
    console.error(`[voice-ai] EXCEÇÃO no turno ${numeroTurno} channel=${channel.id}: ${err.message}`)
    console.error(err.stack)
    return { ok: false, motivo: `excecao: ${err.message}` }
  }
}

function esperarGravacaoConcluir(client, gravacao) {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      console.log(`[voice-ai] TIMEOUT esperando RecordingFinished name=${gravacao.name}`)
      resolve()
    }, (RECORD_MAX_DURATION_S + 10) * 1000)
    function onFinished(ev, rec) {
      if (rec.name !== gravacao.name) return
      clearTimeout(timeoutId)
      client.removeListener('RecordingFinished', onFinished)
      resolve()
    }
    function onFailed(ev, rec) {
      if (rec.name !== gravacao.name) return
      console.log(`[voice-ai] RecordingFailed name=${gravacao.name} cause=${rec.cause}`)
      clearTimeout(timeoutId)
      client.removeListener('RecordingFinished', onFinished)
      client.removeListener('RecordingFailed', onFailed)
      resolve()
    }
    client.on('RecordingFinished', onFinished)
    client.on('RecordingFailed', onFailed)
  })
}
