// Voice AI — cliente genérico para um worker Python PERSISTENTE (STT ou
// TTS), falado via stdin/stdout com um protocolo JSON de uma linha por
// mensagem (ver scripts/voice/stt_worker.py e tts_worker.py). Objetivo:
// pagar o load_ms do modelo (WhisperModel/PiperVoice) UMA vez na subida do
// serviço, não em todo turno — sem isso, cada requisição de voz pagava
// ~2-2.4s só carregando o modelo do zero de novo.
//
// Resiliência (sem pool/call-center, é MVP de 1 chamada por vez):
// - timeout por requisição (nunca deixa uma chamada travada esperando o
//   worker indefinidamente);
// - se o processo morrer inesperadamente, loga claramente e tenta reiniciar
//   um número LIMITADO de vezes (evita loop de restart agressivo); depois
//   disso fica "morto" permanentemente e quem chama (sttBridge/ttsBridge)
//   deve cair pro fallback de subprocesso avulso (scripts antigos), também
//   logando isso claramente — nunca mascarar a degradação em silêncio.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const MAX_RESTARTS_CONSECUTIVOS = 3
const JANELA_RESTART_RAPIDO_MS = 10000

export function criarWorkerPersistente({ label, pythonBin, scriptPath, args = [], requestTimeoutMs = 25000 }) {
  let proc = null
  let rl = null
  let pronto = false
  let morto = false
  let proximoId = 1
  const pendentes = new Map() // id -> { resolve, reject, timeoutId }
  let resolvePronto = null
  let rejeitarPronto = null
  let prontoPromise = null
  let ultimosRestartsMs = []

  function novaPromessaPronto() {
    prontoPromise = new Promise((resolve, reject) => {
      resolvePronto = resolve
      rejeitarPronto = reject
    })
  }

  function limparPendentesComErro(mensagem) {
    for (const [, { reject, timeoutId }] of pendentes) {
      clearTimeout(timeoutId)
      reject(new Error(mensagem))
    }
    pendentes.clear()
  }

  function iniciar() {
    pronto = false
    novaPromessaPronto()
    console.log(`[voice-ai] ${label}_MODEL_LOAD_START`)
    proc = spawn(pythonBin, [scriptPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    rl = createInterface({ input: proc.stdout })

    rl.on('line', (linha) => {
      let msg
      try {
        msg = JSON.parse(linha)
      } catch {
        console.error(`[voice-ai] ${label}_WORKER linha não-JSON ignorada: ${linha.slice(0, 200)}`)
        return
      }

      if (msg.type === 'ready') {
        pronto = true
        console.log(`[voice-ai] ${label}_MODEL_READY load_ms=${msg.load_ms}`)
        resolvePronto({ loadMs: msg.load_ms })
        return
      }

      const pendente = pendentes.get(msg.id)
      if (!pendente) return
      pendentes.delete(msg.id)
      clearTimeout(pendente.timeoutId)
      if (msg.type === 'error') {
        pendente.reject(new Error(msg.message || `${label}_worker retornou erro sem mensagem`))
      } else {
        pendente.resolve(msg)
      }
    })

    proc.stderr.on('data', (chunk) => {
      console.error(`[voice-ai] ${label}_WORKER stderr: ${chunk.toString().trim()}`)
    })

    proc.on('exit', (code, signal) => {
      const eraEsperado = morto
      pronto = false
      limparPendentesComErro(`${label}_worker morreu (code=${code} signal=${signal}) antes de responder`)
      if (eraEsperado) return

      console.error(`[voice-ai] ${label}_WORKER_MORREU code=${code} signal=${signal}`)
      const agora = Date.now()
      ultimosRestartsMs = ultimosRestartsMs.filter((t) => agora - t < JANELA_RESTART_RAPIDO_MS)
      if (ultimosRestartsMs.length >= MAX_RESTARTS_CONSECUTIVOS) {
        morto = true
        rejeitarPronto?.(new Error(`${label}_worker excedeu ${MAX_RESTARTS_CONSECUTIVOS} restarts em ${JANELA_RESTART_RAPIDO_MS}ms — desistindo, fallback permanente`))
        console.error(`[voice-ai] ${label}_WORKER excedeu limite de restarts — NÃO vai mais tentar reiniciar. Bridges devem usar o fallback de subprocesso avulso.`)
        return
      }
      ultimosRestartsMs.push(agora)
      console.error(`[voice-ai] ${label}_WORKER reiniciando (tentativa ${ultimosRestartsMs.length}/${MAX_RESTARTS_CONSECUTIVOS})...`)
      iniciar()
    })
  }

  iniciar()

  return {
    async aguardarPronto() {
      return prontoPromise
    },
    estaPronto() {
      return pronto && !morto
    },
    estaMorto() {
      return morto
    },
    async enviar(payload) {
      if (morto) throw new Error(`${label}_worker está permanentemente indisponível (excedeu restarts) — use o fallback`)
      if (!pronto) throw new Error(`${label}_worker ainda não está pronto`)
      const id = proximoId++
      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          pendentes.delete(id)
          reject(new Error(`${label}_worker: timeout de ${requestTimeoutMs}ms esperando resposta da requisição ${id}`))
        }, requestTimeoutMs)
        pendentes.set(id, { resolve, reject, timeoutId })
        proc.stdin.write(JSON.stringify({ id, ...payload }) + '\n')
      })
    },
    encerrar() {
      morto = true
      limparPendentesComErro(`${label}_worker encerrado deliberadamente`)
      try {
        proc?.stdin?.end()
        proc?.kill()
      } catch {
        // processo já pode estar morto — sem problema
      }
    },
  }
}
