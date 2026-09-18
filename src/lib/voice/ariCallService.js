// Voice AI MVP — serviço ARI turn-based. Homologado num teste isolado com
// tone:ring (sem TTS/Python) confirmando: StasisStart -> answer -> playback
// -> canal permanece vivo, SIP/PJSIP/dialplan/ARI 100% OK. Este arquivo
// agora adiciona o turno completo (captura de fala -> STT -> mesmo cérebro
// do WhatsApp -> TTS -> playback) sobre essa base já provada, mantendo toda
// a instrumentação e o tratamento de exceção por turno (uma falha de mídia
// nunca deve derrubar a ligação sem log).
import AriClient from 'ari-client'
import path from 'node:path'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { transcrever, iniciarSttWorker, aguardarSttPronto } from './sttBridge.js'
import { sintetizar, iniciarTtsWorker, aguardarTtsPronto } from './ttsBridge.js'
import { responderTurno, aquecerCerebro } from './voiceBrain.js'
import { inspecionarWav } from './wavInspector.js'
import { ENDPOINT_PERMITIDO, APP_ARGS_MARCADOR, classificarCausaSemAtendimento } from './outboundInternalTest.js'
import { ENDPOINT_EXTERNO_NVOIP } from './destinoResolver.js'
import { CONTEXTO_MARCADOR as MARCADOR_EXTERNO } from './outboundExternalTest.js'
import { montarSaudacao, FRASE_NAO_ENTENDI, fraseDespedida, fraseEncerramentoNormal, FRASE_TRANSFERIR_HUMANO } from './saudacao.js'
import { filtrarFalaDoRobo, avaliarConfirmacaoResponsavel, ehNegacaoDeIdentidade, ehCaixaPostal, RESPOSTA_ASSUNTO_A_TERCEIRO } from './guardaConteudo.js'
import { finalizarTentativa } from './voiceCallsRepo.js'

// VOICE AI OUTBOUND INTERNAL MVP: a originação em si (o POST que faz o
// telefone tocar) acontece num script separado (scripts/voice/
// trigger-outbound-test.mjs), via REST puro — não precisa da mesma
// conexão WebSocket. Mas todo canal criado com app=ARI_APP (mesmo antes de
// StasisStart) já fica associado a essa app pro Asterisk, então ESTE
// processo (dono da conexão WebSocket já ativa) recebe os eventos de
// ciclo de vida (Ringing/Up/Destroyed) mesmo de canais originados por
// outro processo — é assim que a REST action (originate) e o event stream
// (app subscription) se conectam no ARI. Filtra pelo nome do canal
// (PJSIP/7001-...) já que é o único destino permitido neste MVP.
const PREFIXO_CANAL_OUTBOUND = `${ENDPOINT_PERMITIDO}-`
// BUG REAL corrigido em 17/09/2026, na primeira ligação para um cliente real:
// este filtro só conhecia o ramal interno da homologação (PJSIP/7001-), então
// TODA chamada externa (PJSIP/nvoip-endpoint-...) passava batido. O serviço
// ficava cego: não logava RINGING/ANSWERED/NO_ANSWER e, pior, nunca gravava o
// desfecho em voice_calls — o registro ficava preso em CREATED para sempre e
// o painel não conseguia distinguir quem atendeu de quem não atendeu, que é
// exatamente a métrica que denuncia bloqueio de operadora.
const PREFIXO_CANAL_EXTERNO = `${ENDPOINT_EXTERNO_NVOIP}-`

function ehCanalOutboundNosso(channel) {
  const nome = channel?.name ?? ''
  return nome.startsWith(PREFIXO_CANAL_OUTBOUND) || nome.startsWith(PREFIXO_CANAL_EXTERNO)
}
const canaisOutboundEmStasis = new Set()

// ACHADO (rodada de UX de voz — "chiado" reportado numa ligação real):
// precisamos poder ouvir EXATAMENTE o áudio que tocou numa chamada real
// específica, fora do telefone, sem precisar regenerar nada (regenerar
// produz uma síntese DIFERENTE, já que o Piper tem variação estocástica
// entre gerações). Copia local (fora do \\wsl$, direto no Windows) do
// áudio de cada chamada — pasta é limpa no início de CADA StasisStart, então
// sempre reflete só a ligação mais recente.
const DIAG_ULTIMA_LIGACAO_DIR = process.env.VOICE_LAST_CALL_DIAG_DIR || 'C:\\Users\\msi\\AppData\\Local\\Temp\\vivenzza-last-call'

async function preservarAudioDiagnostico(origemPath, nomeArquivo) {
  try {
    await copyFile(origemPath, path.join(DIAG_ULTIMA_LIGACAO_DIR, nomeArquivo))
  } catch (err) {
    console.error(`[voice-ai] falha ao preservar áudio de diagnóstico (${nomeArquivo}), não crítico: ${err.message}`)
  }
}

// Quanto esperar pelos workers persistentes de STT/TTS carregarem o modelo
// antes de desistir e seguir só com o fallback de subprocesso avulso (mais
// lento, mas nunca impede o serviço de subir — degradação visível nos logs,
// nunca silenciosa).
// ACHADO REAL (18/09/2026, 1a subida depois de um reboot): com o cache de
// disco frio, o modelo do Whisper levou 172s para carregar — o timeout de
// 60s disparou, o serviço marcou o STT como indisponível e avisaria os
// turnos para usar o fallback lento. O worker se recuperou sozinho ao
// ficar pronto, mas o alarme era falso e assustava à toa. 240s cobre a
// máquina fria sem esconder uma falha de verdade.
const WORKER_READY_TIMEOUT_MS = Number(process.env.VOICE_WORKER_READY_TIMEOUT_MS || 240000)

async function aguardarComTimeout(promessa, timeoutMs, rotulo) {
  let timeoutId
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timeout de ${timeoutMs}ms esperando ${rotulo}`)), timeoutMs)
  })
  try {
    return await Promise.race([promessa, timeout])
  } finally {
    clearTimeout(timeoutId)
  }
}

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
// Silêncio entre atender e a primeira palavra — ver comentário no answer().
const PAUSA_APOS_ATENDER_MS = Number(process.env.VOICE_PAUSA_APOS_ATENDER_MS ?? 1200)

// ACHADO REAL (17/09/2026, primeira ligação externa atendida por um humano):
// a saudação antiga ("Este é um teste interno do assistente de voz...") era
// um texto de bancada. Quem atende o telefone não tem o contexto do teste, e
// a ligação soa desconexa — ainda mais porque o cérebro responde com o prompt
// de COBRANÇA nos turnos seguintes. Saudação agora: identifica a marca já na
// primeira frase, diz explicitamente que é um atendimento automatizado
// (transparência — o interlocutor precisa saber que fala com uma máquina) e
// dá uma instrução clara do que fazer. Frases curtas separadas por PONTO,
// porque o TTS usa a pontuação como pausa: sem isso a fala sai atropelada.
// Configurável por env pra ajustar o texto sem mexer em código.
const SAUDACAO = process.env.VOICE_SAUDACAO
  || 'Olá! Aqui é o assistente virtual da Vivenzza Professional. Esta é uma ligação automatizada de atendimento. Pode falar normalmente depois do sinal, que eu te escuto.'
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

  // Sobe os workers persistentes de STT/TTS ANTES de qualquer síntese —
  // assim a pré-geração da saudação/feedback logo abaixo já se beneficia do
  // modelo já carregado (load_ms=0), em vez de pagar esse custo de novo.
  // Se um worker não ficar pronto a tempo, o serviço SEGUE (nunca trava a
  // subida por isso) — sttBridge/ttsBridge caem pro fallback de
  // subprocesso avulso automaticamente, sempre logando a degradação.
  let sttReady = false
  let ttsReady = false
  try {
    iniciarSttWorker()
    await aguardarComTimeout(aguardarSttPronto(), WORKER_READY_TIMEOUT_MS, 'STT_WORKER pronto')
    sttReady = true
  } catch (err) {
    console.error(`[voice-ai] STT_WORKER não ficou pronto (${err.message}) — turnos vão usar o fallback de subprocesso avulso (mais lento)`)
  }

  try {
    iniciarTtsWorker()
    await aguardarComTimeout(aguardarTtsPronto(), WORKER_READY_TIMEOUT_MS, 'TTS_WORKER pronto')
    ttsReady = true
  } catch (err) {
    console.error(`[voice-ai] TTS_WORKER não ficou pronto (${err.message}) — turnos vão usar o fallback de subprocesso avulso (mais lento)`)
  }

  try {
    const t0 = Date.now()
    const resultado = await sintetizar(SAUDACAO, path.join(SOUNDS_DIR, `${NOME_SAUDACAO_FIXA}.wav`))
    saudacaoFixa = { media: `custom/${NOME_SAUDACAO_FIXA}`, duracaoMs: resultado.duracaoAudioMs }
    console.log(`[voice-ai] saudação pré-gerada na subida do serviço, TTS_ms=${Date.now() - t0} duracaoMs=${resultado.duracaoAudioMs} via_worker=${resultado.viaWorker}`)
  } catch (err) {
    console.error(`[voice-ai] falha ao pré-gerar saudação (vai cair pro fallback tone:ring em toda chamada): ${err.message}`)
  }

  try {
    const t0 = Date.now()
    const resultado = await sintetizar(FEEDBACK_IMEDIATO, path.join(SOUNDS_DIR, `${NOME_FEEDBACK_FIXO}.wav`))
    feedbackFixo = { media: `custom/${NOME_FEEDBACK_FIXO}`, duracaoMs: resultado.duracaoAudioMs }
    console.log(`[voice-ai] feedback imediato pré-gerado na subida do serviço, TTS_ms=${Date.now() - t0} duracaoMs=${resultado.duracaoAudioMs} via_worker=${resultado.viaWorker}`)
  } catch (err) {
    console.error(`[voice-ai] falha ao pré-gerar feedback imediato (turno seguirá sem ele, sem travar): ${err.message}`)
  }

  let ollamaReady = false
  try {
    const t0 = Date.now()
    await aquecerCerebro()
    ollamaReady = true
    console.log(`[voice-ai] cérebro (Ollama) aquecido na subida do serviço, warmup_ms=${Date.now() - t0}`)
  } catch (err) {
    console.error(`[voice-ai] falha ao aquecer o cérebro (1ª chamada real pode ficar mais lenta): ${err.message}`)
  }

  const client = await AriClient.connect(ARI_URL, ARI_USER, ARI_PASSWORD)

  // Eventos de ciclo de vida do canal outbound ANTES de entrar em Stasis
  // (a originação em si roda noutro processo — ver nota acima do arquivo).
  // Só loga pra canais que nunca chegaram a StasisStart (senão duplicaria
  // o que instrumentarCanal() já loga depois de StasisStart).
  client.on('ChannelStateChange', (event, channel) => {
    if (!ehCanalOutboundNosso(channel) || canaisOutboundEmStasis.has(channel.id)) return
    if (channel.state === 'Ring' || channel.state === 'Ringing') {
      console.log(`[voice-ai] OUTBOUND_EVENT=RINGING channel=${channel.id}`)
      canaisQueTocaram.add(channel.id)
    }
    if (channel.state === 'Up') {
      console.log(`[voice-ai] OUTBOUND_EVENT=ANSWERED channel=${channel.id}`)
      auditarAtendimento(channel.id)
    }
  })
  client.on('ChannelDestroyed', (event, channel) => {
    // canaisJaAuditados protege contra a corrida: o finally do StasisStart
    // remove o canal de canaisOutboundEmStasis ANTES de o ChannelDestroyed
    // chegar do Asterisk, e sem isto este handler reabria uma chamada já
    // conversada como NO_ANSWER.
    if (!ehCanalOutboundNosso(channel) || canaisOutboundEmStasis.has(channel.id) || canaisJaAuditados.has(channel.id)) return
    const resultado = classificarCausaSemAtendimento(event.cause)
    console.log(`[voice-ai] OUTBOUND_EVENT=${resultado} channel=${channel.id} cause=${event.cause} cause_txt="${event.cause_txt}" (nunca entrou em conversa — desligado antes de atender)`)
    const classificado = classificarEncerramento(channel.id, resultado)
    if (classificado !== resultado) {
      console.log(`[voice-ai] OUTBOUND_EVENT reclassificado ${resultado} -> ${classificado} (o telefone chegou a tocar) channel=${channel.id}`)
    }
    auditarEncerramento(channel.id, {
      status: classificado,
      hangupCause: event.cause_txt ?? String(event.cause),
      failureClass: classificado === 'COMPLETED' ? null : classificado,
    })
    canaisQueTocaram.delete(channel.id)
  })

  client.on('StasisStart', async (event, channel) => {
    // ACHADO DA REVISÃO (17/09/2026): só o marcador do teste INTERNO era
    // reconhecido, então TODA ligação de cobrança entrava como
    // outbound=false. Efeito: a auditoria classificava a chamada como
    // "nunca entrou em conversa" e o painel ficava mentindo justamente na
    // métrica que denuncia bloqueio de operadora.
    const ehOutbound = Array.isArray(event.args)
      && (event.args.includes(APP_ARGS_MARCADOR) || event.args.includes(MARCADOR_EXTERNO))
    if (ehOutbound) canaisOutboundEmStasis.add(channel.id)
    console.log(`[voice-ai] StasisStart channel=${channel.id} outbound=${ehOutbound}`)
    if (ehOutbound) console.log(`[voice-ai] OUTBOUND_EVENT=STASIS_START channel=${channel.id}`)
    instrumentarCanal(channel)

    let statusFinal = 'FAILED'
    let ultimoIntent = null
    let ultimoRequiresHuman = false
    const transcricoes = []

    try {
      await rm(DIAG_ULTIMA_LIGACAO_DIR, { recursive: true, force: true }).catch(() => {})
      await mkdir(DIAG_ULTIMA_LIGACAO_DIR, { recursive: true })
      console.log(`[voice-ai] pasta de diagnóstico da última ligação limpa: ${DIAG_ULTIMA_LIGACAO_DIR}`)
    } catch (err) {
      console.error(`[voice-ai] falha preparando pasta de diagnóstico, não crítico: ${err.message}`)
    }

    try {
      // Canal outbound originado com `app` já chega ANSWERED em Stasis por
      // definição do próprio ARI (só entra na app quando atendido) — um
      // answer() redundante aqui não teria efeito útil e some casos do
      // Asterisk retornam erro pra isso, então pulamos pro outbound.
      if (!ehOutbound) {
        console.log(`[voice-ai] answer() channel=${channel.id}`)
        await channel.answer()
        console.log(`[voice-ai] answer() OK channel=${channel.id}`)
      }
      {
        // ACHADO REAL (17/09/2026, ouvindo a ligação): o áudio começava no
        // instante do atendimento e a pessoa perdia o início da frase — o
        // celular leva cerca de um segundo pra abrir o caminho de som depois
        // que o usuário encosta no botão. Esta pausa é curta o bastante pra
        // não parecer chamada muda e longa o bastante pra ninguém perder o
        // "Olá".
        if (PAUSA_APOS_ATENDER_MS > 0) {
          await new Promise((r) => setTimeout(r, PAUSA_APOS_ATENDER_MS))
          console.log(`[voice-ai] pausa de ${PAUSA_APOS_ATENDER_MS}ms após atender (caminho de áudio do celular) channel=${channel.id}`)
        }
      }

      if (ehOutbound) console.log(`[voice-ai] OUTBOUND_EVENT=CONVERSATION_STARTED channel=${channel.id}`)
      // Nome do contato, quando a fila mandou. Falhar aqui NUNCA pode
      // derrubar a ligação: sem nome, cai na abertura genérica por função.
      let clienteNome = null
      try {
        const v = await new Promise((resolve) => {
          channel.getChannelVar({ variable: 'VIVENZZA_CLIENTE_NOME' }, (err, res) => resolve(err ? null : res?.value))
        })
        clienteNome = v || null
      } catch { clienteNome = null }

      const textoSaudacao = montarSaudacao(clienteNome)
      console.log(`[voice-ai] SAUDACAO channel=${channel.id} nome=${clienteNome ? 'sim' : 'nao'} texto="${textoSaudacao}"`)

      await tocarComFallback(channel, async () => {
        const nome = `voice-ai-${channel.id}-saudacao`
        try {
          const r = await sintetizar(textoSaudacao, path.join(SOUNDS_DIR, `${nome}.wav`))
          return { media: `custom/${nome}`, duracaoMs: r.duracaoAudioMs }
        } catch (err) {
          console.error(`[voice-ai] TTS da saudação personalizada falhou (${err.message}) — caindo na saudação pré-gerada`)
          if (!saudacaoFixa) throw new Error('saudação pré-gerada indisponível')
          return saudacaoFixa
        }
      }, 'saudação')
      if (saudacaoFixa) await preservarAudioDiagnostico(path.join(SOUNDS_DIR, `${NOME_SAUDACAO_FIXA}.wav`), '01-saudacao.wav')
      if (feedbackFixo) await preservarAudioDiagnostico(path.join(SOUNDS_DIR, `${NOME_FEEDBACK_FIXO}.wav`), '02-feedback.wav')

      let turno = 1
      let reprompts = 0
      const estadoConversa = { responsavelConfirmado: false }
      let encerramentoFalado = false
      for (; turno <= MAX_TURNOS; turno++) {
        console.log(`[voice-ai] === turno ${turno}/${MAX_TURNOS} channel=${channel.id} ===`)
        const continuar = await executarTurno(client, channel, turno, estadoConversa)
        if (!continuar.ok) {
          // ACHADO REAL (17/09/2026): quando o STT nao entendia, o loop
          // quebrava e o finally desligava SEM DIZER NADA. Do lado do
          // cliente isso e simplesmente "a ligacao caiu do nada" -- foi o
          // relato literal. Numa cobranca isso e pior que nao ligar: queima
          // a marca e o cliente nao sabe nem quem era. Agora pedimos para
          // repetir ate REPROMPTS_MAXIMOS e, so entao, nos despedimos.
          if (continuar.caixaPostal) {
            statusFinal = 'CAIXA_POSTAL'
            ultimoIntent = 'CAIXA_POSTAL'
            if (continuar.transcript) transcricoes.push(continuar.transcript)
            encerramentoFalado = true // de propósito: NÃO falamos com secretária eletrônica
            break
          }
          reprompts++
          console.log(`[voice-ai] turno ${turno} sem diálogo válido (${continuar.motivo}) — reprompt ${reprompts}/${REPROMPTS_MAXIMOS}`)
          if (reprompts > REPROMPTS_MAXIMOS) {
            await falar(channel, fraseDespedida(), 'despedida')
            encerramentoFalado = true
            break
          }
          await falar(channel, FRASE_NAO_ENTENDI, 'reprompt')
          continue
        }
        reprompts = 0
        ultimoRequiresHuman = continuar.requiresHuman
        ultimoIntent = continuar.intent ?? ultimoIntent
        if (continuar.transcript) transcricoes.push(continuar.transcript)
        if (continuar.requiresHuman) {
          // ACHADO DA REVISÃO (17/09/2026): aqui o código dava break e o
          // finally desligava. Ou seja: o cliente pedia para falar com uma
          // pessoa e era DESLIGADO na hora. É o pior desfecho possível numa
          // cobrança — pior do que nunca ter ligado.
          console.log(`[voice-ai] turno ${turno} — requires_human=true, avisando o cliente antes de encerrar`)
          await falar(channel, FRASE_TRANSFERIR_HUMANO, 'transferir-humano')
          encerramentoFalado = true
          break
        }
      }

      // ACHADO DA REVISÃO: quando o for terminava por esgotar MAX_TURNOS,
      // ninguém falava nada e o finally desligava. Do lado do cliente isso é
      // exatamente "a ligação caiu do nada". Nenhum caminho pode encerrar
      // calado.
      if (!encerramentoFalado) {
        await falar(channel, fraseEncerramentoNormal(), 'encerramento')
        encerramentoFalado = true
      }
      console.log(`[voice-ai] fim do loop de turnos channel=${channel.id} ultimoRequiresHuman=${ultimoRequiresHuman}`)
      if (statusFinal !== 'CAIXA_POSTAL') statusFinal = 'COMPLETED'
      if (ehOutbound) console.log(`[voice-ai] OUTBOUND_EVENT=COMPLETED channel=${channel.id}`)
    } catch (err) {
      console.error(`[voice-ai] EXCEÇÃO não tratada no ciclo da chamada channel=${channel.id}: ${err.message}`)
      console.error(err.stack)
      if (ehOutbound) console.log(`[voice-ai] OUTBOUND_EVENT=FAILED channel=${channel.id} motivo="${err.message}"`)
    } finally {
      try {
        await channel.hangup()
        console.log(`[voice-ai] hangup() explícito OK channel=${channel.id}`)
      } catch (e) {
        console.log(`[voice-ai] hangup() explícito falhou (provavelmente já desligado) channel=${channel.id}: ${e.message}`)
      }
      if (ehOutbound) {
        console.log(`[voice-ai] OUTBOUND_EVENT=HANGUP channel=${channel.id}`)
        canaisJaAuditados.add(channel.id)
        // Ponto ÚNICO de fechamento da auditoria para chamadas que chegaram
        // a conversar. Espera curta para o ChannelDestroyed trazer a causa.
        await new Promise((r) => setTimeout(r, 400))
        await auditarEncerramento(channel.id, {
          status: statusFinal,
          hangupCause: causaDesligamento.get(channel.id) ?? null,
          failureClass: statusFinal === 'COMPLETED' ? null : statusFinal,
          intentFinal: ultimoIntent,
          requiresHuman: ultimoRequiresHuman,
          transcricao: transcricoes.length ? transcricoes.join(' | ') : null,
        })
        causaDesligamento.delete(channel.id)
        canaisOutboundEmStasis.delete(channel.id)
        setTimeout(() => canaisJaAuditados.delete(channel.id), 60000)
      }
    }
  })

  client.start(ARI_APP)
  console.log(`[voice-ai] conectado ao ARI (${ARI_URL}), app="${ARI_APP}", aguardando chamadas...`)
  console.log(`[voice-ai] VOICE_READY ari=true ollama=${ollamaReady} stt_worker=${sttReady} tts_worker=${ttsReady}`)
  return client
}

// --- Auditoria em voice_calls -------------------------------------------
// Fecha o registro que trigger-external-test.mjs abriu ao originar. É o que
// transforma "ligamos" em "foi atendida, durou X, terminou assim" — sem isto
// o painel não consegue distinguir uma chamada bem-sucedida de uma que a
// operadora bloqueou, que é justamente o alarme mais importante.
//
// SEMPRE best-effort: uma falha de banco NUNCA pode derrubar uma ligação em
// andamento. Erro aqui vira log, não exceção.
const atendidaEm = new Map()
const causaDesligamento = new Map()
const canaisJaAuditados = new Set()
// Canais que chegaram a fazer o telefone TOCAR do outro lado (183/Ringing).
const canaisQueTocaram = new Set()

// ACHADO REAL (17/09/2026, primeiras ligações para clientes reais): a Nvoip
// encerra a chamada não atendida com causa 0 ("Unknown"), que
// classificarCausaSemAtendimento() joga em FAILED por não conhecer o código.
// Resultado: "o cliente não atendeu" (normal em cobrança, 15-35% de contato é
// o benchmark) virava "falha técnica" no painel — justamente a métrica que
// denuncia bloqueio de operadora. Se o telefone CHEGOU A TOCAR e ninguém
// atendeu, isso é NO_ANSWER. FAILED fica reservado para o que nem tocou.
function classificarEncerramento(channelId, resultadoBruto) {
  if (resultadoBruto === 'FAILED' && canaisQueTocaram.has(channelId)) return 'NO_ANSWER'
  return resultadoBruto
}

async function auditarAtendimento(channelId) {
  const quando = new Date().toISOString()
  atendidaEm.set(channelId, quando)
  try {
    await finalizarTentativa({ callId: channelId, status: 'ANSWERED', answeredAt: quando, endedAt: null })
  } catch (err) {
    console.warn(`[voice-ai] auditoria: nao consegui marcar atendimento de ${channelId} — ${err.message}`)
  }
}

async function auditarEncerramento(channelId, { status, hangupCause = null, failureClass = null, intentFinal = null, requiresHuman = null, transcricao = null } = {}) {
  const inicio = atendidaEm.get(channelId)
  const fim = new Date().toISOString()
  const duracao = inicio ? Math.max(0, Math.round((new Date(fim) - new Date(inicio)) / 1000)) : 0
  atendidaEm.delete(channelId)
  try {
    await finalizarTentativa({
      callId: channelId,
      status,
      answeredAt: inicio ?? null,
      endedAt: fim,
      durationSeconds: duracao,
      hangupCause,
      failureClass,
      // ACHADO DO PILOTO (18/09/2026): estes três campos eram montados no
      // finally e DESCARTADOS aqui — por isso intent, requires_human e
      // transcrição chegavam sempre NULL no banco. Sem eles a régua nunca
      // enxerga promessa de pagamento e ninguém fica sabendo de um pedido
      // de atendimento humano.
      intentFinal,
      requiresHuman,
      transcricao,
    })
  } catch (err) {
    console.warn(`[voice-ai] auditoria: nao consegui fechar ${channelId} — ${err.message}`)
  }
}

function instrumentarCanal(channel) {
  channel.on('ChannelStateChange', (ev, ch) => console.log(`[voice-ai] ChannelStateChange channel=${ch.id} state=${ch.state}`))
  channel.on('ChannelHangupRequest', (ev, ch) => console.log(`[voice-ai] ChannelHangupRequest channel=${ch.id} cause=${ev.cause} soft=${ev.soft}`))
  channel.on('ChannelDestroyed', (ev, ch) => {
    // ACHADO DA REVISÃO: isto gravava COMPLETED INCONDICIONALMENTE, inclusive
    // para ligações que estouraram exceção, e corria com o handler de app
    // (que gravava FAILED/NO_ANSWER na mesma chamada). Quem gravasse por
    // último vencia — status não-determinístico. Agora a auditoria tem DONO
    // ÚNICO: quem entrou em Stasis é fechado pelo finally do StasisStart.
    // Aqui só guardamos a causa real do desligamento.
    console.log(`[voice-ai] ChannelDestroyed channel=${ch.id} cause=${ev.cause} cause_txt="${ev.cause_txt}"`)
    causaDesligamento.set(ch.id, ev.cause_txt ?? String(ev.cause))
    canaisQueTocaram.delete(ch.id)
  })
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

// Quantas vezes pedimos "pode repetir?" antes de encerrar com educação.
const REPROMPTS_MAXIMOS = Number(process.env.VOICE_REPROMPTS_MAXIMOS || 2)

// Fala uma frase avulsa (reprompt, despedida). Best-effort: nunca derruba.
async function falar(channel, texto, rotulo) {
  await tocarComFallback(channel, async () => {
    const nome = `voice-ai-${channel.id}-${rotulo}-${Date.now()}`
    const r = await sintetizar(texto, path.join(SOUNDS_DIR, `${nome}.wav`))
    return { media: `custom/${nome}`, duracaoMs: r.duracaoAudioMs }
  }, rotulo)
}

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

  // ACHADO DA REVISÃO: o fallback era 'tone:ring'. Do lado de quem JÁ
  // atendeu, ouvir tom de chamada no meio da conversa é incompreensível e
  // destrói o posicionamento premium. O feedback pré-gerado ("só um
  // instante") é sempre melhor que um trim-trim.
  const fallback = feedbackFixo ? `sound:${feedbackFixo.media}` : 'tone:ring'
  const mediaUri = media ? `sound:${media}` : fallback
  if (!media) console.warn(`[voice-ai] FALLBACK_DE_MIDIA (${rotulo}) usando ${mediaUri} channel=${channel.id}`)
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
      // ACHADO DA REVISÃO: sem este removeListener vazava um listener por
      // ÁUDIO TOCADO — e como PlaybackFinished nunca chega neste ari-client,
      // o timeout é o caminho normal, ou seja, vazava sempre.
      channel.removeListener('PlaybackFinished', onFinished)
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
async function executarTurno(client, channel, numeroTurno, estado = { responsavelConfirmado: false }) {
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
    const { texto: transcript, transcribeMs, loadMs: sttLoadMs, requestMs: sttRequestMs, viaWorker: sttViaWorker } = await transcrever(wavGravado)
    const sttWallMs = Date.now() - tStt0
    const sttBridgeOverheadMs = sttWallMs - (transcribeMs ?? 0) - (sttLoadMs ?? 0)
    console.log(`[voice-ai] STT_FINISHED turno=${numeroTurno} stt_wall_ms=${sttWallMs} STT_request_ms=${sttRequestMs} STT_transcribe_ms=${transcribeMs} stt_load_ms=${sttLoadMs} stt_bridge_overhead_ms=${sttBridgeOverheadMs} via_worker=${sttViaWorker} caracteres=${transcript.length}`)
    // HOMOLOGAÇÃO INTERNAL_TEST (voz do próprio operador, não cliente real) —
    // log verboso do transcript só nesta fase de diagnóstico controlado,
    // nunca em produção real (ver nota equivalente em replySuggestion.js).
    console.log(`[voice-ai] TRANSCRIPT turno=${numeroTurno}: "${transcript}"`)

    if (!transcript.trim()) {
      console.log(`[voice-ai] transcript vazio turno=${numeroTurno} — nada reconhecido, encerrando sem travar`)
      return { ok: false, motivo: 'transcript_vazio' }
    }

    // CAIXA POSTAL: encerra NA HORA, sem dizer mais nada. Nenhuma palavra
    // sobre o assunto vai para uma secretária eletrônica que qualquer um
    // escuta depois. Marca o desfecho para a régua tratar como "não falamos
    // com ninguém" e tentar de novo noutra faixa de horário.
    if (ehCaixaPostal(transcript)) {
      console.log(`[voice-ai] CAIXA_POSTAL detectada turno=${numeroTurno} channel=${channel.id} — encerrando sem deixar recado`)
      return { ok: false, motivo: 'caixa_postal', caixaPostal: true, transcript, intent: 'CAIXA_POSTAL' }
    }

    // ATALHO DETERMINÍSTICO (18/09/2026): quando a pessoa NEGA ser a
    // responsável, a resposta é fixa — não há nada para o modelo decidir.
    // Pular o cérebro aqui derruba os ~7s de espera do turno mais comum de
    // todos: responderTurno faz DUAS chamadas ao modelo em sequência
    // (classificar + gerar). Menos silêncio morto, menos chance de o cliente
    // desligar, e zero risco de o modelo inventar frase.
    const negouIdentidade = !estado.responsavelConfirmado && ehNegacaoDeIdentidade(transcript)

    let resultado
    let llmMs = 0
    if (negouIdentidade) {
      resultado = { intent: 'NAO_E_O_RESPONSAVEL', requiresHuman: false, respostaTexto: RESPOSTA_ASSUNTO_A_TERCEIRO }
      console.log(`[voice-ai] ATALHO_SEM_LLM turno=${numeroTurno} channel=${channel.id} motivo=negacao_de_identidade`)
    } else {
      console.log(`[voice-ai] LLM_STARTED turno=${numeroTurno} channel=${channel.id}`)
      const tLlm0 = Date.now()
      resultado = await responderTurno(transcript)
      llmMs = Date.now() - tLlm0
    }

    // A confirmação de identidade é avaliada por REGRA, não pelo modelo: é
    // ela que destranca falar de título/valor/vencimento (Art. 42 do CDC).
    if (!estado.responsavelConfirmado && avaliarConfirmacaoResponsavel(transcript)) {
      estado.responsavelConfirmado = true
      console.log(`[voice-ai] RESPONSAVEL_CONFIRMADO turno=${numeroTurno} channel=${channel.id}`)
    }

    // Trava determinística sobre a fala do robô. Prompt é intenção; isto é
    // garantia. Se o modelo tentar falar de dívida antes da confirmação, a
    // frase dele é DESCARTADA e trocada pela resposta fixa.
    const filtrado = filtrarFalaDoRobo(resultado.respostaTexto, { responsavelConfirmado: estado.responsavelConfirmado })
    if (filtrado.bloqueado) {
      console.warn(`[voice-ai] FALA_BLOQUEADA turno=${numeroTurno} motivo=${filtrado.motivo} channel=${channel.id} — substituída pela resposta fixa a terceiro`)
    }
    resultado.respostaTexto = filtrado.texto
    console.log(`[voice-ai] LLM_FINISHED turno=${numeroTurno} LLM_ms=${llmMs} intent=${resultado.intent} requiresHuman=${resultado.requiresHuman}`)

    // ACHADO (correção de medição, mesma rodada de PARTE C): a 1ª versão
    // desta instrumentação calculava time_to_real_reply_ms DEPOIS do
    // `await tocarComFallback(...)` inteiro — mas tocarComFallback não só
    // gera o áudio, também DISPARA o playback e ESPERA a duração inteira
    // dele terminar (esperarPlaybackFinalizar). Isso inflava o número em
    // ~8.5s (a duração do próprio áudio de resposta) numa chamada real,
    // aparecendo como "overhead não explicado" que na verdade era tempo de
    // playback, não de processamento. Fix: capturar time_to_real_reply_ms
    // no instante em que a resposta fica PRONTA (fim do TTS), de dentro do
    // callback `gerarMedia`, antes do play() ser sequer chamado — mesmo
    // ponto de medição que a versão original (pré-instrumentação) usava.
    const nomeResposta = `voice-ai-${channel.id}-resposta${numeroTurno}`
    let ttsWallMs = 0
    let ttsLoadMs = null
    let ttsSynthMs = null
    let timeToRealReplyMs = null
    await tocarComFallback(channel, async () => {
      const t0tts = Date.now()
      const wavResposta = path.join(SOUNDS_DIR, `${nomeResposta}.wav`)
      const resultadoTts = await sintetizar(resultado.respostaTexto, wavResposta)
      ttsWallMs = Date.now() - t0tts
      ttsLoadMs = resultadoTts.loadMs
      ttsSynthMs = resultadoTts.synthMs
      timeToRealReplyMs = Date.now() - tPosRecord
      const ttsBridgeOverheadMs = ttsWallMs - (ttsSynthMs ?? 0) - (ttsLoadMs ?? 0)
      // audio_preroll_ms é só silêncio ANEXADO ao áudio já pronto (custo de
      // escrita ~0ms, incluído no synth_ms acima) — NÃO é tempo de espera
      // nem entra separadamente em nenhum cálculo de latência de
      // processamento; só alonga a DURAÇÃO do playback. Logado à parte
      // para ficar auditável, por pedido explícito desta rodada de UX.
      console.log(`[voice-ai] TTS_FINISHED turno=${numeroTurno} tts_wall_ms=${ttsWallMs} TTS_request_ms=${resultadoTts.requestMs} TTS_synth_ms=${ttsSynthMs} tts_load_ms=${ttsLoadMs} tts_bridge_overhead_ms=${ttsBridgeOverheadMs} audio_preroll_ms=${resultadoTts.audioPrerollMs} via_worker=${resultadoTts.viaWorker} duracaoMs=${resultadoTts.duracaoAudioMs}`)
      console.log(`[voice-ai] time_to_real_reply_ms=${timeToRealReplyMs} turno=${numeroTurno} (do fim da gravação até a resposta pronta pra tocar — NÃO inclui a duração do playback nem o preroll)`)
      await preservarAudioDiagnostico(wavResposta, `0${2 + numeroTurno}-resposta-turno${numeroTurno}.wav`)
      return { media: `custom/${nomeResposta}`, duracaoMs: resultadoTts.duracaoAudioMs }
    }, `resposta-turno${numeroTurno}`)

    const somaEstagiosMs = wavInspectMs + sttWallMs + llmMs + ttsWallMs
    const overheadNaoExplicadoMs = timeToRealReplyMs - somaEstagiosMs
    console.log(`[voice-ai] LATENCIA_RESUMO turno=${numeroTurno} time_to_feedback_ms=${timeToFeedbackMs} wav_inspect_ms=${wavInspectMs} stt_wall_ms=${sttWallMs} llm_ms=${llmMs} tts_wall_ms=${ttsWallMs} soma_estagios_ms=${somaEstagiosMs} time_to_real_reply_ms=${timeToRealReplyMs} overhead_nao_explicado_ms=${overheadNaoExplicadoMs}`)

    return { ok: true, requiresHuman: resultado.requiresHuman, intent: resultado.intent, transcript, falaBloqueada: filtrado.bloqueado }
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
