// Fake Anthropic Messages API — servidor HTTP local que simula o endpoint
// POST /v1/messages o suficiente para os testes de sdr.js (que só lê
// response.content[0].text). Mesmo espírito de scripts/tests/fakes/
// fakeEvolution.js: comportamento 100% controlável por teste, sem depender
// de rede/chave real. O SDK oficial (@anthropic-ai/sdk) lê ANTHROPIC_BASE_URL
// do ambiente automaticamente quando nenhum baseURL é passado no construtor
// — não precisa alterar src/routes/sdr.js pra apontar pra cá.
import express from 'express'

export function criarFakeAnthropic() {
  const app = express()
  app.use(express.json())

  // comportamento: 'ok' (default) | 'error' | 'timeout'
  let comportamento = 'ok'
  let textoResposta = '{"resposta":"resposta padrão de teste","audio_script":null,"acao":"NENHUMA","tipo_lead":"indefinido","proximo_estado":"qualificando","temperatura":"frio","etapa_cadencia":1}'
  let statusErro = 500
  const chamadasRecebidas = []

  function controlar({ comportamento: c, texto, statusErro: se } = {}) {
    if (c) comportamento = c
    if (texto !== undefined) textoResposta = texto
    if (se) statusErro = se
  }

  function resetar() {
    comportamento = 'ok'
    textoResposta = '{"resposta":"resposta padrão de teste","audio_script":null,"acao":"NENHUMA","tipo_lead":"indefinido","proximo_estado":"qualificando","temperatura":"frio","etapa_cadencia":1}'
    statusErro = 500
    chamadasRecebidas.length = 0
  }

  app.post('/v1/messages', (req, res) => {
    chamadasRecebidas.push({ body: req.body, timestamp: Date.now() })
    if (comportamento === 'timeout') return // nunca responde — o SDK tem timeout próprio (10min default)
    if (comportamento === 'error') return res.status(statusErro).json({ type: 'error', error: { type: 'api_error', message: 'erro simulado' } })
    res.json({
      id: `msg_fake_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-6',
      content: [{ type: 'text', text: textoResposta }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 10 },
    })
  })

  function iniciar(porta = 0) {
    return new Promise((resolve) => {
      const server = app.listen(porta, '127.0.0.1', () => {
        const enderecoReal = server.address()
        resolve({
          url: `http://127.0.0.1:${enderecoReal.port}`,
          controlar,
          resetar,
          chamadasRecebidas,
          // closeAllConnections evita travar caso o comportamento 'timeout'
          // tenha deixado alguma conexão pendente sem resposta (mesmo achado
          // documentado em fakeEvolution.js).
          parar: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }),
        })
      })
    })
  }

  return { iniciar }
}
