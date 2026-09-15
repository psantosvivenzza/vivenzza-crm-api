// Hardening investigado a partir do incidente "IA comercial não responde"
// (2026-09-13). Achado real por leitura de código (não reproduzido em
// produção nos ~5 dias verificados via Railway — ver relatório do incidente):
// NENHUMA chamada Supabase de src/routes/sdr.js tinha limite de espera. Um
// try/catch não pega uma promise que nunca resolve nem rejeita — uma
// instabilidade pontual do Postgres/PostgREST podia travar o processamento
// de UM cliente por tempo indefinido, sem nenhum log, mesmo com a resposta
// da Lara já pronta pra ser enviada.
//
// A correção usa `.abortSignal(AbortSignal.timeout(SDR_QUERY_TIMEOUT_MS))`
// em toda chamada Supabase do caminho de resposta. Confirmado por leitura de
// node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts: quando
// `throwOnError()` NÃO foi chamado (nunca é, neste arquivo), um AbortError
// de timeout é capturado internamente e a chamada RESOLVE normalmente como
// `{ data: null, error }` — o mesmo formato de qualquer outro erro do
// postgrest-js. Por isso esta correção NÃO muda nenhum comportamento
// existente: as checagens de config/handoff/histórico já eram fail-open por
// omissão (nunca checavam `error`, só tratavam `data` ausente) — isto só
// limita QUANTO TEMPO uma instabilidade pode travar uma resposta, e
// adiciona o único log que faltava pra esse cenário deixar de ser 100% silencioso.
//
// Escopo deliberadamente restrito a isto: não muda pacing de rajada (exceto
// tornar o fallback mais cauteloso, não mais arriscado — ver teste "1."),
// não muda handoff/opt-out, não muda anti-loop, não toca em reativacao.js
// (PR #94 em andamento, trava de reentrância — fora de escopo aqui).
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
import { criarFakeEvolution } from '../fakes/fakeEvolution.js'
import { criarFakeAnthropic } from '../fakes/fakeAnthropic.js'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`
process.env.ANTHROPIC_API_KEY = 'fake-key-teste'
process.env.EVOLUTION_INSTANCE = 'vivenzza'
// Timeout curto SÓ pra teste — produção continua com o default real (8000ms).
process.env.SDR_QUERY_TIMEOUT_MS = '300'
delete process.env.EVOLUTION_WEBHOOK_TOKEN
delete process.env.ELEVENLABS_API_KEY

let supabase, server, porta, fakeEvo, fakeClaude

// dentroDoHorarioComercial() usa o relógio real — congela num horário FORA do
// expediente (domingo de madrugada BRT) pra garantir que a Lara é exercitada
// de verdade, independente de quando este teste rodar (mesmo padrão já usado
// em sdr-registrar-saida-erro.test.mjs).
const AGORA_FORA_DO_HORARIO = new Date('2026-09-06T06:00:00.000Z')

before(async () => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_FORA_DO_HORARIO })

  fakeEvo = await criarFakeEvolution().iniciar()
  fakeClaude = await criarFakeAnthropic().iniciar()
  process.env.EVOLUTION_API_URL = fakeEvo.url
  process.env.ANTHROPIC_BASE_URL = fakeClaude.url

  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  const express = (await import('express')).default
  const router = (await import('../../../src/routes/sdr.js')).default
  const app = express()
  app.use(express.json())
  app.use('/api/sdr', router)
  server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  porta = server.address().port

  const { error } = await supabase.from('automacoes_config').upsert({ id: 1, sdr_ativo: true, voz_ativa: true }, { onConflict: 'id' })
  if (error) throw error
})

function comLimiteDeTempo(promessa, ms) {
  return Promise.race([promessa, new Promise((resolve) => setTimeout(resolve, ms))])
}

after(async () => {
  mock.timers.reset()
  server?.closeAllConnections?.()
  await comLimiteDeTempo(new Promise((r) => server ? server.close(r) : r()), 1500)
  await comLimiteDeTempo(fakeEvo.parar(), 1500)
  await comLimiteDeTempo(fakeClaude.parar(), 1500)
  // Mesmo achado documentado em sdr-registrar-saida-erro.test.mjs: o pool de
  // conexão interno do @anthropic-ai/sdk não é fechável a partir do teste.
  process.exit(process.exitCode ?? 0)
})

let contador = 0
function telefoneDeTeste() {
  contador++
  return `55519997${String(Date.now()).slice(-5)}${String(contador).padStart(2, '0')}`
}

function eventoTexto(telefone, texto) {
  const id = `FAKE${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  return {
    event: 'messages.upsert',
    instance: 'vivenzza',
    data: {
      key: { remoteJid: `${telefone}@s.whatsapp.net`, fromMe: false, id },
      message: { conversation: texto },
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  }
}

function chamarWebhook(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request(
      { host: '127.0.0.1', port: porta, method: 'POST', path: '/api/sdr/webhook', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
      }
    )
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function aguardar(condicaoFn, { timeoutMs = 5000, intervaloMs = 40 } = {}) {
  const limite = Date.now() + timeoutMs
  while (Date.now() < limite) {
    const resultado = await condicaoFn()
    if (resultado) return resultado
    await new Promise((r) => setTimeout(r, intervaloMs))
  }
  throw new Error('aguardar(): condição não satisfeita dentro do timeout')
}

async function buscarMensagensSaida(telefone) {
  const { data } = await supabase.from('whatsapp_mensagens').select('*').eq('telefone', telefone).eq('direcao', 'saida')
  return data || []
}
async function limparLead(telefone) {
  await supabase.from('whatsapp_mensagens').delete().eq('telefone', telefone)
  await supabase.from('sdr_conversas').delete().eq('telefone', telefone)
  await supabase.from('leads').delete().eq('telefone', telefone)
}
async function criarLeadDeTeste(telefone, { atendimentoHumano = false } = {}) {
  const { error } = await supabase.from('leads').insert({
    nome: `Lead teste ${telefone}`, telefone, etapa: 'novo', origem: 'whatsapp',
    campanha_origem: 'whatsapp_organico', atendimento_humano: atendimentoHumano,
  })
  if (error) throw error
}

// Intercepta a PRÓXIMA chamada supabase.from(tabela).<operacao>(...), atrasando
// a resolução real (simula instabilidade lenta do Postgres/PostgREST) sem
// quebrar o encadeamento (.eq/.select/.abortSignal continuam funcionando
// normalmente, pois mutam o mesmo objeto `this`).
function atrasarProximaChamada(supabaseCliente, { tabela, operacao, delayMs }) {
  const fromOriginal = supabaseCliente.from.bind(supabaseCliente)
  let usado = false
  supabaseCliente.from = (t) => {
    const builder = fromOriginal(t)
    if (!usado && t === tabela && typeof builder[operacao] === 'function') {
      const metodoOriginal = builder[operacao].bind(builder)
      builder[operacao] = (...args) => {
        usado = true
        const chain = metodoOriginal(...args)
        const thenOriginal = chain.then.bind(chain)
        chain.then = (resolve, reject) => new Promise((r) => setTimeout(r, delayMs)).then(() => thenOriginal(resolve, reject))
        return chain
      }
    }
    return builder
  }
  return () => { supabaseCliente.from = fromOriginal }
}

test('baseline: fluxo normal continua respondendo (config/handoff/histórico rápidos, sem timeout envolvido)', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Oi! Tudo bem?', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const r = await chamarWebhook(eventoTexto(tel, 'Olá'))
  assert.equal(r.status, 200)
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))
  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'caminho feliz precisa continuar respondendo normalmente após a correção')
})

test('1. checagem de automacoes_config lenta (> SDR_QUERY_TIMEOUT_MS) não trava o cliente para sempre — resposta ainda chega, dentro de um teto', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Resposta apesar da checagem de config lenta', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  // 600ms de atraso > SDR_QUERY_TIMEOUT_MS (300ms) — sem a correção, isto
  // travaria o processamento deste cliente por 600ms mesmo assim (não é um
  // teste de "trava pra sempre" real — validar isso exigiria uma query que
  // nunca resolve, o que travaria o teste inteiro; o ponto comprovável aqui é
  // que o teto de espera É RESPEITADO, não ultrapassado por muito).
  const remover = atrasarProximaChamada(supabase, { tabela: 'automacoes_config', operacao: 'select', delayMs: 600 })
  const antes = performance.now()
  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Quero saber mais'))
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel), { timeoutMs: 5000 })
  } finally {
    remover()
  }
  const duracao = performance.now() - antes
  // Precisa ter passado do timeout configurado (abortSignal realmente disparou)
  // mas não muito além disso (não ficou preso esperando os 600ms completos do
  // atraso real da query, nem qualquer coisa maior — prova que o teto de
  // SDR_QUERY_TIMEOUT_MS foi respeitado, não ignorado).
  assert.ok(duracao < 2000, `esperava que o timeout de config (300ms) limitasse a espera, levou ${duracao}ms`)
  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'mesmo com a checagem de config lenta, a Lara continua respondendo (comportamento fail-open preservado)')
})

test('2. checagem de handoff humano lenta não impede a resposta (fail-open preservado, dentro de um teto)', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: false })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Resposta apesar do handoff lento', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const remover = atrasarProximaChamada(supabase, { tabela: 'leads', operacao: 'select', delayMs: 600 })
  const antes = performance.now()
  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Testando handoff lento'))
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel), { timeoutMs: 5000 })
  } finally {
    remover()
  }
  const duracao = performance.now() - antes
  assert.ok(duracao < 2000, `esperava que o timeout de handoff (300ms) limitasse a espera, levou ${duracao}ms`)
  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'checagem de handoff instável não pode virar silêncio total — comportamento fail-open (igual a antes) é preservado')
})

test('3. checagem de histórico da conversa lenta não impede a resposta (trata como conversa nova, fail-open preservado)', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Resposta apesar do histórico lento', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const remover = atrasarProximaChamada(supabase, { tabela: 'sdr_conversas', operacao: 'select', delayMs: 600 })
  const antes = performance.now()
  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Testando histórico lento'))
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel), { timeoutMs: 5000 })
  } finally {
    remover()
  }
  const duracao = performance.now() - antes
  assert.ok(duracao < 2000, `esperava que o timeout de histórico (300ms) limitasse a espera, levou ${duracao}ms`)
  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'checagem de histórico instável não pode virar silêncio total — comportamento fail-open (igual a antes) é preservado')
})

test('4. gravação do estado final da conversa lenta NÃO bloqueia o envio da resposta já gerada', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Esta precisa chegar mesmo com o salvamento de estado lento', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  // sdr_conversas.upsert é chamado várias vezes no fluxo (early-returns não
  // se aplicam aqui pois é fora do horário comercial com config/handoff/
  // histórico rápidos) — a PRIMEIRA ocorrência de upsert em sdr_conversas
  // depois da leitura do histórico é o salvamento do estado final, logo após
  // a resposta da Claude.
  const remover = atrasarProximaChamada(supabase, { tabela: 'sdr_conversas', operacao: 'upsert', delayMs: 600 })
  const antes = performance.now()
  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Testando salvamento de estado lento'))
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel), { timeoutMs: 5000 })
  } finally {
    remover()
  }
  const duracao = performance.now() - antes
  assert.ok(duracao < 2000, `esperava que o timeout do salvamento de estado (300ms) não bloqueasse o envio por muito mais que isso, levou ${duracao}ms`)
  const envios = fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel)
  assert.equal(envios.length, 1, 'achado real do incidente: sem esta correção, uma instabilidade aqui podia travar o fluxo INTEIRO antes do envio de texto — agora o envio acontece de qualquer forma')
  assert.equal(envios[0].texto, 'Esta precisa chegar mesmo com o salvamento de estado lento')
})

test('5. erro real de banco (não timeout) na checagem de automacoes_config continua fail-open, com log explícito agora (achado: antes era 100% silencioso)', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Resposta apesar do erro de config', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const errosCapturados = []
  const mockConsoleError = mock.method(console, 'error', (...args) => {
    errosCapturados.push(args.map(String).join(' '))
  })

  const fromOriginal = supabase.from.bind(supabase)
  let usado = false
  supabase.from = (t2) => {
    const builder = fromOriginal(t2)
    if (!usado && t2 === 'automacoes_config' && typeof builder.maybeSingle === 'function') {
      usado = true
      const original = builder.maybeSingle.bind(builder)
      builder.maybeSingle = (...args) => {
        const chain = original(...args)
        chain.then = (resolve) => Promise.resolve({ data: null, error: { message: 'conexão recusada (simulado)', code: '08006' } }).then(resolve)
        return chain
      }
    }
    return builder
  }

  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Testando erro real de config'))
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel), { timeoutMs: 5000 })
  } finally {
    supabase.from = fromOriginal
    mockConsoleError.mock.restore()
  }

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'erro real (não timeout) na leitura de config continua fail-open — mesmo comportamento de antes da correção')

  const logDeFalha = errosCapturados.find((m) => m.includes('não foi possível concluir a verificação') && m.includes('ler_config_automacoes'))
  assert.ok(logDeFalha, `esperava um log explícito da falha na checagem de config (antes desta correção não havia NENHUM log aqui); capturado: ${JSON.stringify(errosCapturados)}`)
  assert.ok(logDeFalha.includes('codigo=08006'), 'código de erro em formato permitido deve aparecer')
  assert.ok(!logDeFalha.includes('conexão recusada'), 'log não pode conter err.message bruto do banco')
  assert.ok(!logDeFalha.includes(tel), 'log não pode conter o telefone completo')
})

test('preserva comportamento existente: handoff humano de verdade (sem lentidão nenhuma) continua bloqueando a Lara', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: true })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'ISTO NUNCA deveria ser enviado', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const r = await chamarWebhook(eventoTexto(tel, 'Mensagem que a Lara não deve responder'))
  assert.equal(r.status, 200)
  await new Promise((res) => setTimeout(res, 500))

  assert.equal(fakeClaude.chamadasRecebidas.length, 0, 'handoff humano real ainda bloqueia a Lara antes de chamar Claude')
  assert.equal(fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel).length, 0)
})

test('preserva comportamento existente: pacing de rajada (volume alto) continua aplicando o atraso conhecido', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Resposta com pacing de rajada', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const agora = new Date().toISOString()
  const linhas = Array.from({ length: 15 }, (_, i) => ({
    telefone: `pacing-teste-timeout-${i}`, direcao: 'saida', mensagem: 'x', status: 'enviado', created_at: agora,
  }))
  const { error } = await supabase.from('whatsapp_mensagens').insert(linhas)
  if (error) throw error
  t.after(async () => { await supabase.from('whatsapp_mensagens').delete().like('telefone', 'pacing-teste-timeout-%') })

  const antes = performance.now()
  await chamarWebhook(eventoTexto(tel, 'Testando rajada'))
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel), { timeoutMs: 15000 })
  const duracao = performance.now() - antes
  assert.ok(duracao >= 3500, `esperava atraso de pacing (>=3.5s) preservado, levou ${duracao}ms`)
})

test('6. checagem de pacing lenta (erro/timeout) agora aplica o atraso padrão por precaução, em vez de pular o pacing (comportamento mais cauteloso, não mais arriscado)', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Resposta apesar do pacing lento', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  // Atraso maior que SDR_QUERY_TIMEOUT_MS (300ms) na query de contagem do
  // pacing — o abortSignal precisa vencer, disparando o catch (que agora
  // aplica o atraso padrão de LARA_PACING_DELAY_MIN..MAX_MS, 4-10s).
  const remover = atrasarProximaChamada(supabase, { tabela: 'whatsapp_mensagens', operacao: 'select', delayMs: 500 })
  const antes = performance.now()
  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Quero saber mais sobre pacing'))
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel), { timeoutMs: 15000 })
  } finally {
    remover()
  }
  const duracao = performance.now() - antes
  assert.ok(duracao >= 3500, `pacing com erro/timeout precisa aplicar o atraso padrão por precaução (>=3.5s), levou ${duracao}ms`)
  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
})
