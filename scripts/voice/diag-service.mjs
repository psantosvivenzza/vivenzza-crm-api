// Voice AI MVP — DIAGNÓSTICO isolado, sem TTS/Python/UNC. Usa tone:ring
// (gerado pelo próprio Asterisk, nenhum arquivo de som necessário) pra
// provar isoladamente: StasisStart -> answer -> playback -> canal
// permanece vivo. Instrumenta TODOS os eventos relevantes do ciclo de vida
// do canal, nunca deixa exceção matar a sessão silenciosamente.
import AriClient from 'ari-client'

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088'
const ARI_USER = process.env.ARI_USER
const ARI_PASSWORD = process.env.ARI_PASSWORD
const ARI_APP = process.env.ARI_APP || 'vivenzza-voice-ai'

if (!ARI_USER || !ARI_PASSWORD) throw new Error('ARI_USER/ARI_PASSWORD não configurados')

const client = await AriClient.connect(ARI_URL, ARI_USER, ARI_PASSWORD)

client.on('StasisStart', async (event, channel) => {
  console.log(`[diag] StasisStart channel=${channel.id}`)

  channel.on('ChannelStateChange', (ev, ch) => console.log(`[diag] ChannelStateChange channel=${ch.id} state=${ch.state}`))
  channel.on('ChannelHangupRequest', (ev, ch) => console.log(`[diag] ChannelHangupRequest channel=${ch.id} cause=${ev.cause} soft=${ev.soft}`))
  channel.on('ChannelDestroyed', (ev, ch) => console.log(`[diag] ChannelDestroyed channel=${ch.id} cause=${ev.cause} cause_txt="${ev.cause_txt}"`))
  channel.on('StasisEnd', (ev, ch) => console.log(`[diag] StasisEnd (channel-level) channel=${ch.id}`))
  channel.on('PlaybackStarted', (ev, pb) => console.log(`[diag] PlaybackStarted id=${pb.id} media_uri=${pb.media_uri}`))
  channel.on('PlaybackFinished', (ev, pb) => console.log(`[diag] PlaybackFinished id=${pb.id}`))
  channel.on('PlaybackFailed', (ev, pb) => console.log(`[diag] PlaybackFailed id=${pb?.id} state=${pb?.state}`))

  try {
    console.log(`[diag] chamando answer() channel=${channel.id}`)
    await channel.answer()
    console.log(`[diag] answer() OK channel=${channel.id}`)

    console.log(`[diag] solicitando playback tone:ring channel=${channel.id}`)
    const playback = await new Promise((resolve, reject) => {
      channel.play({ media: 'tone:ring;duration=3000' }, (err, pb) => (err ? reject(err) : resolve(pb)))
    })
    console.log(`[diag] play() aceito, playbackId=${playback.id} channel=${channel.id}`)

    await new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        console.log(`[diag] TIMEOUT (20s) esperando PlaybackFinished — playback pode ter travado, channel=${channel.id}`)
        resolve()
      }, 20000)
      function onFinished(ev, pb) {
        if (pb.id !== playback.id) return
        clearTimeout(timeoutId)
        channel.removeListener('PlaybackFinished', onFinished)
        resolve()
      }
      channel.on('PlaybackFinished', onFinished)
    })

    console.log(`[diag] ciclo de playback concluído — mantendo canal vivo por 30s pra observação manual, channel=${channel.id}`)
    await new Promise((resolve) => setTimeout(resolve, 30000))
    console.log(`[diag] fim da janela de observação, encerrando de propósito channel=${channel.id}`)
  } catch (err) {
    console.error(`[diag] EXCEÇÃO durante o ciclo channel=${channel.id}: ${err.message}`)
    console.error(err.stack)
  } finally {
    try {
      await channel.hangup()
      console.log(`[diag] hangup() explícito OK channel=${channel.id}`)
    } catch (e) {
      console.log(`[diag] hangup() explícito falhou (provavelmente já desligado por fora) channel=${channel.id}: ${e.message}`)
    }
  }
})

client.on('StasisEnd', (event, channel) => {
  console.log(`[diag] (client-level) StasisEnd channel=${channel.id}`)
})

client.start(ARI_APP)
console.log(`[diag] conectado ao ARI (${ARI_URL}), app="${ARI_APP}", aguardando chamada de diagnóstico (tone:ring, sem TTS)...`)
