// Fake Evolution API — servidor HTTP local que simula o protocolo real da
// Evolution API (endpoints confirmados em docs/cobranca-ai/EVOLUTION.md) para
// testes de integração sem depender de uma instância real. Comportamento por
// instância é 100% controlável via `controlarInstancia()`, chamado diretamente
// pelos testes (mesmo processo — não precisa de endpoint HTTP de controle).
//
// FASE C.1 (homologação, 2026-08-11) — ampliado pra cobrir toda a taxonomia de
// classifyEvolutionFailure() (evolutionAdapter.js): sucesso, falha técnica
// inequívoca (500/502/timeout/connection_drop), rate limit (429), auth
// (401/403), número inválido/destinatário indisponível, falha genérica
// ambígua (400), envio tardio (late_success — testa que uma resposta atrasada
// de uma tentativa já abandonada não corrompe o dispatch), e healthcheck
// (fetchInstances/connectionState).
import express from 'express'

export function criarFakeEvolution() {
  const app = express()
  app.use(express.json())

  // Estado por instância:
  // { comportamento: 'ok'|'fail_explicit'|'unavailable'|'bad_gateway'|'timeout'|
  //   'rate_limited'|'unauthorized'|'forbidden'|'disconnected'|'connection_drop'|
  //   'recipient_unavailable'|'pending_forever'|'late_success',
  //   connectionStatus: 'open'|'close'|'connecting',
  //   atrasoMs: number (usado só por 'late_success') }
  // CONNECTION_REFUSED/ETIMEDOUT/DNS (erro de transporte puro, sem nenhuma
  // resposta HTTP) não são simuláveis por ESTE servidor fake rodando de
  // verdade — são testados via chamada direta e isolada de
  // classifyEvolutionFailure() com um erro sintético (ver evolution-failure-
  // classifier.test.mjs), não via round-trip HTTP.
  const instancias = new Map()
  const mensagensEnviadas = [] // histórico de envios reais recebidos, para assertions

  function estadoDe(nome) {
    if (!instancias.has(nome)) instancias.set(nome, { comportamento: 'ok', connectionStatus: 'open', atrasoMs: 300 })
    return instancias.get(nome)
  }

  function controlarInstancia(nome, { comportamento, connectionStatus, atrasoMs } = {}) {
    const atual = estadoDe(nome)
    if (comportamento) atual.comportamento = comportamento
    if (connectionStatus) atual.connectionStatus = connectionStatus
    if (atrasoMs != null) atual.atrasoMs = atrasoMs
  }

  function resetar() {
    instancias.clear()
    mensagensEnviadas.length = 0
  }

  // POST /chat/whatsappNumbers/:instance — confirma existência do número.
  app.post('/chat/whatsappNumbers/:instance', (req, res) => {
    const estado = estadoDe(req.params.instance)
    if (estado.comportamento === 'unavailable') return res.status(503).json({ message: 'Instância indisponível' })
    if (estado.comportamento === 'timeout') return; // nunca responde — o axios do adapter tem timeout próprio
    const numeros = req.body.numbers || []
    // Número de teste terminado em "000" simula "não existe no WhatsApp".
    const resultado = numeros.map((n) => ({ jid: n, exists: !n.endsWith('000') }))
    res.json(resultado)
  })

  // POST /message/sendText/:instance — envio real (ponto central dos testes de failover).
  app.post('/message/sendText/:instance', (req, res) => {
    const nomeInstancia = req.params.instance
    const estado = estadoDe(nomeInstancia)
    const msgId = `fake-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    function registrarEnvioReal() {
      mensagensEnviadas.push({ instancia: nomeInstancia, numero: req.body.number, texto: req.body.text, msgId, timestamp: Date.now() })
    }

    switch (estado.comportamento) {
      // Ambíguo de propósito — nenhum sinal claro de "a instância caiu" nem de
      // categoria conhecida (rate limit/auth/número). Sob classifyEvolutionFailure()
      // isso vira PLATFORM_RESTRICTION, NÃO failover-eligible.
      case 'fail_explicit':
        return res.status(400).json({ message: 'Erro simulado: falha explícita de envio' })
      // Técnica inequívoca (5xx) — TECHNICAL_RETRYABLE, failover-eligible.
      case 'unavailable':
        return res.status(500).json({ message: 'Erro simulado: instância indisponível' })
      case 'bad_gateway':
        return res.status(502).json({ message: 'Erro simulado: bad gateway' })
      // Rate limit — NUNCA failover-eligible (pedido explícito: pausar/backoff,
      // nunca trocar de número pra contornar limite do provedor).
      case 'rate_limited':
        return res.status(429).json({ message: 'Erro simulado: rate limit' })
      // Credencial — outra instância não resolve, NUNCA failover-eligible.
      case 'unauthorized':
        return res.status(401).json({ message: 'Erro simulado: não autorizado' })
      case 'forbidden':
        return res.status(403).json({ message: 'Erro simulado: acesso negado' })
      // 4xx ambíguo — mesma categoria de fail_explicit (PLATFORM_RESTRICTION).
      case 'disconnected':
        return res.status(400).json({ message: 'Instância desconectada' })
      // Destinatário indisponível/bloqueou — problema do dado, não da instância.
      case 'recipient_unavailable':
        return res.status(400).json({ message: 'Destinatário indisponível ou bloqueou o remetente' })
      case 'connection_drop':
        return req.socket.destroy() // simula ECONNRESET — TECHNICAL_RETRYABLE
      case 'timeout':
      case 'pending_forever':
        return // nunca responde — cliente recebe ETIMEDOUT/ECONNABORTED
      // Resposta de sucesso ATRASADA — simula a tentativa 1 "succeeding late",
      // depois que o cliente já desistiu (timeout) e possivelmente já fez
      // failover pra outra instância. O envio é registrado em mensagensEnviadas
      // mesmo que o cliente HTTP já tenha abandonado a conexão — é assim que se
      // testa "resposta tardia não deveria corromper o dispatch" (a mensagem
      // realmente foi enviada pelo provedor, só a confirmação chegou tarde).
      case 'late_success':
        setTimeout(() => {
          registrarEnvioReal()
          if (!res.headersSent) res.json({ key: { id: msgId }, message: { conversation: req.body.text } })
        }, estado.atrasoMs)
        return
      default:
        registrarEnvioReal()
        return res.json({ key: { id: msgId }, message: { conversation: req.body.text } })
    }
  })

  app.get('/instance/connectionState/:instance', (req, res) => {
    const estado = estadoDe(req.params.instance)
    res.json({ instance: { state: estado.connectionStatus } })
  })

  app.get('/instance/fetchInstances', (req, res) => {
    const lista = [...instancias.entries()].map(([name, estado]) => ({
      name, instance: { instanceName: name, connectionStatus: estado.connectionStatus },
    }))
    res.json(lista)
  })

  app.get('/instance/connect/:instance', (req, res) => {
    res.json({ base64: 'data:image/png;base64,ZmFrZS1xcmNvZGU=', instance: { state: 'connecting' } })
  })

  function iniciar(porta = 0) {
    return new Promise((resolve) => {
      const server = app.listen(porta, '127.0.0.1', () => {
        const enderecoReal = server.address()
        resolve({
          url: `http://127.0.0.1:${enderecoReal.port}`,
          controlarInstancia,
          resetar,
          mensagensEnviadas,
          parar: () => new Promise((r) => server.close(r)),
        })
      })
    })
  }

  return { iniciar }
}
