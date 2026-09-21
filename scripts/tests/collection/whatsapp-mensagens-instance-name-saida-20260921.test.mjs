// Achado confirmado pela auditoria adversarial b264e419: mensagens de SAÍDA
// comerciais gravadas em whatsapp_mensagens por src/routes/sdr.js (Lara) e
// src/routes/whatsapp.js (envio manual/mídia/áudio) nunca preenchiam
// instance_name — a coluna existe desde a migration 20260101000041 (criada
// pra resolver um vazamento de mensagens FINANCEIRAS pra dentro de threads
// comerciais), mas só o lado financeiro (webhook-handler.js, mensagens de
// ENTRADA) gravava o valor. Qualquer análise por instância (health, volume
// comercial x financeiro) ficava cega pra toda resposta da Lara e todo envio
// manual/mídia feito por um vendedor.
//
// Correção testada aqui: os 4 pontos de insert de saída em sdr.js/whatsapp.js
// agora gravam instance_name = a MESMA constante server-side (EVOLUTION_INSTANCE/
// INSTANCE) usada na própria chamada evolutionApi.post — nunca um valor vindo
// do body do cliente (o body de /api/whatsapp/enviar* não tem nem carrega
// esse campo). Fallback: se a coluna ainda não existir no ambiente (PGRST204 —
// mesmo tratamento já usado em webhook-handler.js), regrava sem ela, sem
// perder o registro local nem duplicar o envio.
//
// ESCOPO DELIBERADAMENTE ISOLADO — só os 4 inserts de saída comercial
// tocados nesta PR. src/routes/reativacao.js tem o MESMO padrão (grava
// whatsapp_mensagens sem instance_name, também usando EVOLUTION_INSTANCE),
// mas fica de fora de propósito (achado separado, fora do escopo confirmado
// pela auditoria b264e419 — PR pequena e separada por domínio).
import { test, before, after, mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import express from 'express'
import jwt from 'jsonwebtoken'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
import { criarFakeEvolution } from '../fakes/fakeEvolution.js'
import { criarFakeAnthropic } from '../fakes/fakeAnthropic.js'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste'
process.env.ANTHROPIC_API_KEY = 'fake-key-teste'
process.env.EVOLUTION_INSTANCE = 'vivenzza' // mesmo default de produção — determinístico pro teste
delete process.env.EVOLUTION_WEBHOOK_TOKEN // webhookAuth sem token configurado = skip (mesmo padrão de produção sem token)
delete process.env.ELEVENLABS_API_KEY // fora de escopo — áudio da Lara (ElevenLabs) nunca é exercitado aqui

const INSTANCIA_COMERCIAL_ESPERADA = 'vivenzza'

let supabase, serverSdr, serverWhatsapp, portaSdr, portaWhatsapp, fakeEvoLara, fakeClaude
let fakeEvoManual, portaFakeEvoManual
let tokenVendedor

// Dentro do horário comercial (seg-sex 08:20-18:00 BRT) o time humano assume
// e a Lara fica deliberadamente silenciosa (dentroDoHorarioComercial() em
// sdr.js) — ela só responde via Claude FORA do horário. Mesmo valor de
// sdr-registrar-saida-erro.test.mjs (domingo de madrugada), pelo mesmo motivo.
const AGORA_FORA_DO_HORARIO = new Date('2026-09-06T06:00:00.000Z') // domingo 03:00 BRT

// Fake Evolution dedicado às rotas manuais de whatsapp.js (sendText/sendMedia/
// sendWhatsAppAudio) — não reaproveita scripts/tests/fakes/fakeEvolution.js de
// propósito (mesma decisão documentada em
// whatsapp-enviar-midia-mediatype-path-traversal-20260913.test.mjs: aquele
// fake compartilhado não implementa sendMedia/sendWhatsAppAudio, e criar um
// servidor dedicado aqui evita qualquer alteração em infraestrutura de teste
// compartilhada). Modo controlável por teste: 'ok' (default) ou 'indisponivel'
// (500, simula instância desconectada/config inválida).
function criarFakeEvolutionManual() {
  let modo = 'ok'
  const server = http.createServer((req, res) => {
    req.resume() // drena o body — não precisamos inspecioná-lo aqui
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (modo === 'indisponivel') {
        res.statusCode = 500
        res.end(JSON.stringify({ message: 'Erro simulado: instância indisponível' }))
        return
      }
      if (req.method === 'POST' && /^\/message\/(sendText|sendMedia|sendWhatsAppAudio)\//.test(req.url)) {
        res.end(JSON.stringify({ key: { id: `fake-manual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` } }))
        return
      }
      res.statusCode = 404
      res.end()
    })
  })
  return { server, setModo: (m) => { modo = m } }
}

before(async () => {
  fakeEvoLara = await criarFakeEvolution().iniciar()
  fakeClaude = await criarFakeAnthropic().iniciar()
  process.env.ANTHROPIC_BASE_URL = fakeClaude.url

  const fakeManual = criarFakeEvolutionManual()
  fakeEvoManual = fakeManual
  await new Promise((resolve) => fakeManual.server.listen(0, '127.0.0.1', resolve))
  portaFakeEvoManual = fakeManual.server.address().port

  // sdr.js e whatsapp.js leem EVOLUTION_API_URL na primeira importação —
  // ambos usam a MESMA env var, então não dá pra apontar cada router pra um
  // fake HTTP diferente dentro do mesmo processo. Usamos o fake do Lara
  // (fakeEvoLara, sendText apenas) pro router de sdr.js e criamos o app de
  // whatsapp.js com EVOLUTION_API_URL redirecionado pro fake manual —
  // resolvido montando os dois em processos... não é preciso: como cada
  // router lê `process.env.EVOLUTION_API_URL` só uma vez no top-level, na
  // primeira importação do módulo, basta importar sdr.js primeiro (aponta
  // pro fake do Lara) e SÓ DEPOIS trocar a env var antes de importar
  // whatsapp.js (aponta pro fake manual) — cada módulo captura o valor da
  // env var vigente no momento do seu próprio import.
  process.env.EVOLUTION_API_URL = fakeEvoLara.url
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  const sdrRouter = (await import('../../../src/routes/sdr.js')).default

  const appSdr = express()
  appSdr.use(express.json())
  appSdr.use('/api/sdr', sdrRouter)
  serverSdr = await new Promise((resolve) => { const s = appSdr.listen(0, '127.0.0.1', () => resolve(s)) })
  portaSdr = serverSdr.address().port

  process.env.EVOLUTION_API_URL = `http://127.0.0.1:${portaFakeEvoManual}`
  const { auth } = await import('../../../src/middleware/auth.js')
  const whatsappRouter = (await import('../../../src/routes/whatsapp.js')).default

  const appWhatsapp = express()
  appWhatsapp.use(express.json({ limit: '20mb' }))
  appWhatsapp.use('/api/whatsapp', auth, whatsappRouter) // mesmo mount de src/index.js
  serverWhatsapp = await new Promise((resolve) => { const s = appWhatsapp.listen(0, '127.0.0.1', () => resolve(s)) })
  portaWhatsapp = serverWhatsapp.address().port

  tokenVendedor = jwt.sign({ id: 'vendedor-teste', email: 'vendedor@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)

  const { error } = await supabase.from('automacoes_config').upsert({ id: 1, sdr_ativo: true, voz_ativa: false }, { onConflict: 'id' })
  if (error) throw error
})

function comLimiteDeTempo(promessa, ms) {
  return Promise.race([promessa, new Promise((resolve) => setTimeout(resolve, ms))])
}

after(async () => {
  serverSdr?.closeAllConnections?.()
  serverWhatsapp?.closeAllConnections?.()
  await comLimiteDeTempo(new Promise((r) => serverSdr ? serverSdr.close(r) : r()), 1500)
  await comLimiteDeTempo(new Promise((r) => serverWhatsapp ? serverWhatsapp.close(r) : r()), 1500)
  await comLimiteDeTempo(fakeEvoLara.parar(), 1500)
  await comLimiteDeTempo(new Promise((r) => fakeEvoManual.server.close(r)), 1500)
  await comLimiteDeTempo(fakeClaude.parar(), 1500)
  // Mesmo achado documentado em sdr-registrar-saida-erro.test.mjs e em
  // whatsapp-enviar-midia-mediatype-path-traversal-20260913.test.mjs:
  // importar sdr.js registra um setInterval sem .unref() e o pool do
  // @anthropic-ai/sdk não fecha sozinho — sem isso o processo nunca encerra.
  await new Promise((resolve) => setTimeout(resolve, 200))
  process.exit(process.exitCode ?? 0)
})

let contador = 0
function telefoneDeTeste() {
  contador++
  return `5551999${String(Date.now()).slice(-6)}${String(contador).padStart(2, '0')}`
}

function chamarHttp(porta, method, path, { body = null, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {}
    if (token) headers.authorization = `Bearer ${token}`
    const data = body ? JSON.stringify(body) : null
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data) }
    const req = http.request({ host: '127.0.0.1', port: porta, method, path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
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
  const { data, error } = await supabase.from('leads').insert({
    nome: `Lead teste ${telefone}`, telefone, etapa: 'novo', origem: 'whatsapp',
    campanha_origem: 'whatsapp_organico', atendimento_humano: atendimentoHumano,
  }).select('id').single()
  if (error) throw error
  return data.id
}

// Mesmo interceptor de sdr-registrar-saida-erro.test.mjs: substitui a PRÓXIMA
// chamada supabase.from(tabela).<operacao>(...) (a N-ésima ocorrência) por um
// erro simulado, sem quebrar o encadeamento e sem impedir chamadas
// posteriores (usadas pelo fallback real do código de produção) de rodarem
// normalmente contra o banco de teste.
function interceptarChamada(supabaseCliente, { tabela, operacao, erroSimulado, ocorrencia = 1 }) {
  const fromOriginal = supabaseCliente.from.bind(supabaseCliente)
  let vistas = 0
  supabaseCliente.from = (t) => {
    const builder = fromOriginal(t)
    if (t === tabela && typeof builder[operacao] === 'function') {
      const metodoOriginal = builder[operacao].bind(builder)
      builder[operacao] = (...args) => {
        vistas++
        const chain = metodoOriginal(...args)
        if (vistas === ocorrencia) {
          chain.then = (resolve, reject) => Promise.resolve({ data: null, error: erroSimulado }).then(resolve, reject)
        }
        return chain
      }
    }
    return builder
  }
  return () => { supabaseCliente.from = fromOriginal }
}

test('Lara (webhook sdr.js) grava instance_name = EVOLUTION_INSTANCE na resposta de saída', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_FORA_DO_HORARIO })
  const tel = telefoneDeTeste()
  t.after(() => { mock.timers.reset(); return limparLead(tel) })
  fakeEvoLara.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: false })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Oi! Como posso ajudar?', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const r = await new Promise((resolve, reject) => {
    const data = JSON.stringify(eventoTexto(tel, 'Olá'))
    const req = http.request({ host: '127.0.0.1', port: portaSdr, method: 'POST', path: '/api/sdr/webhook', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let chunks = ''; res.on('data', (c) => { chunks += c }); res.on('end', () => resolve({ status: res.statusCode }))
    })
    req.on('error', reject); req.write(data); req.end()
  })
  assert.equal(r.status, 200)

  const saidas = await aguardar(async () => { const s = await buscarMensagensSaida(tel); return s.length > 0 ? s : null })
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA, 'a resposta da Lara precisa gravar a instância comercial que realmente enviou')
})

test('POST /api/whatsapp/enviar (envio manual) grava instance_name = INSTANCE', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvoManual.setModo('ok')
  const leadId = await criarLeadDeTeste(tel)

  const r = await chamarHttp(portaWhatsapp, 'POST', '/api/whatsapp/enviar', {
    token: tokenVendedor,
    body: { lead_id: leadId, numero: tel, mensagem: 'Segue o orçamento combinado' },
  })
  assert.equal(r.status, 200, `esperava 200; resposta: ${JSON.stringify(r.body)}`)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA)
})

test('POST /api/whatsapp/enviar-midia grava instance_name = INSTANCE', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvoManual.setModo('ok')
  const leadId = await criarLeadDeTeste(tel)

  const r = await chamarHttp(portaWhatsapp, 'POST', '/api/whatsapp/enviar-midia', {
    token: tokenVendedor,
    body: {
      lead_id: leadId, numero: tel,
      media: Buffer.from('conteudo-sintetico-de-teste').toString('base64'),
      mediatype: 'document', mimetype: 'application/pdf', fileName: 'orcamento.pdf', caption: 'segue',
    },
  })
  assert.equal(r.status, 200, `esperava 200; resposta: ${JSON.stringify(r.body)}`)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA)
  assert.equal(saidas[0].media_tipo, 'document')
})

test('POST /api/whatsapp/enviar-audio grava instance_name = INSTANCE', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvoManual.setModo('ok')
  const leadId = await criarLeadDeTeste(tel)

  const r = await chamarHttp(portaWhatsapp, 'POST', '/api/whatsapp/enviar-audio', {
    token: tokenVendedor,
    body: { lead_id: leadId, numero: tel, audio: Buffer.from('audio-sintetico').toString('base64'), mimeType: 'audio/webm' },
  })
  assert.equal(r.status, 200, `esperava 200; resposta: ${JSON.stringify(r.body)}`)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA)
  assert.equal(saidas[0].media_tipo, 'audio')
})

test('instância indisponível/config inválida (Evolution falha) — nenhuma linha é gravada, nenhum instance_name fantasma', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvoManual.setModo('indisponivel')
  t.after(() => fakeEvoManual.setModo('ok'))
  const leadId = await criarLeadDeTeste(tel)

  const r = await chamarHttp(portaWhatsapp, 'POST', '/api/whatsapp/enviar', {
    token: tokenVendedor,
    body: { lead_id: leadId, numero: tel, mensagem: 'Isto nunca deveria ser registrado localmente' },
  })
  assert.notEqual(r.status, 200, 'a rota precisa propagar a falha da Evolution, não fingir sucesso')

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 0, 'sem envio real confirmado, nenhuma linha (com ou sem instance_name) pode ser gravada')
})

test('instância indisponível/config inválida — mesmo comportamento na Lara (sdr.js)', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_FORA_DO_HORARIO })
  const tel = telefoneDeTeste()
  t.after(() => { mock.timers.reset(); return limparLead(tel) })
  fakeEvoLara.resetar()
  fakeClaude.resetar()
  fakeEvoLara.controlarInstancia(INSTANCIA_COMERCIAL_ESPERADA, { comportamento: 'unavailable' })
  await criarLeadDeTeste(tel, { atendimentoHumano: false })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Isto nunca deveria ser registrado localmente', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const errosCapturados = []
  const mockConsoleError = mock.method(console, 'error', (...args) => { errosCapturados.push(args.map(String).join(' ')) })
  try {
    const r = await new Promise((resolve, reject) => {
      const data = JSON.stringify(eventoTexto(tel, 'Preciso de ajuda'))
      const req = http.request({ host: '127.0.0.1', port: portaSdr, method: 'POST', path: '/api/sdr/webhook', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let chunks = ''; res.on('data', (c) => { chunks += c }); res.on('end', () => resolve({ status: res.statusCode }))
      })
      req.on('error', reject); req.write(data); req.end()
    })
    assert.equal(r.status, 200) // webhook sempre responde 200 pra Evolution — o erro é assíncrono, em background
    await aguardar(() => errosCapturados.some((m) => m.includes('erro ao enviar texto')))
  } finally {
    mockConsoleError.mock.restore()
  }

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 0, 'Evolution recusou o envio — nenhuma linha local pode ser criada, muito menos com instance_name preenchido')
})

test('coluna instance_name ainda não existe (PGRST204 simulado) — fallback grava a linha sem ela, sem duplicar o envio', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvoManual.setModo('ok')
  const leadId = await criarLeadDeTeste(tel)

  const remover = interceptarChamada(supabase, {
    tabela: 'whatsapp_mensagens', operacao: 'insert', ocorrencia: 1,
    erroSimulado: { code: 'PGRST204', message: "Could not find the 'instance_name' column of 'whatsapp_mensagens' in the schema cache" },
  })
  let r
  try {
    r = await chamarHttp(portaWhatsapp, 'POST', '/api/whatsapp/enviar', {
      token: tokenVendedor,
      body: { lead_id: leadId, numero: tel, mensagem: 'Mensagem enviada mesmo com a coluna nova ausente' },
    })
  } finally {
    remover()
  }
  assert.equal(r.status, 200, `esperava 200 mesmo com a migration ainda não aplicada; resposta: ${JSON.stringify(r.body)}`)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'o fallback precisa gravar a linha mesmo sem a coluna nova — nunca perder o registro local por causa disso')
  assert.equal(saidas[0].mensagem, 'Mensagem enviada mesmo com a coluna nova ausente')
})

test('coluna instance_name ainda não existe (PGRST204 simulado) — mesmo fallback na Lara (sdr.js), sem reenvio', async (t) => {
  mock.timers.enable({ apis: ['Date'], now: AGORA_FORA_DO_HORARIO })
  const tel = telefoneDeTeste()
  t.after(() => { mock.timers.reset(); return limparLead(tel) })
  fakeEvoLara.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: false })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Resposta com coluna nova ausente', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  // ocorrencia:1 — aplicarPacingLara só faz um SELECT (não insert) antes
  // disso; o 1º INSERT em whatsapp_mensagens é exatamente a tentativa com
  // instance_name feita por registrarMensagemSaida, que este teste força a
  // falhar com PGRST204.
  const remover = interceptarChamada(supabase, {
    tabela: 'whatsapp_mensagens', operacao: 'insert', ocorrencia: 1,
    erroSimulado: { code: 'PGRST204', message: "Could not find the 'instance_name' column of 'whatsapp_mensagens' in the schema cache" },
  })
  try {
    const r = await new Promise((resolve, reject) => {
      const data = JSON.stringify(eventoTexto(tel, 'Testando fallback de coluna ausente'))
      const req = http.request({ host: '127.0.0.1', port: portaSdr, method: 'POST', path: '/api/sdr/webhook', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
        let chunks = ''; res.on('data', (c) => { chunks += c }); res.on('end', () => resolve({ status: res.statusCode }))
      })
      req.on('error', reject); req.write(data); req.end()
    })
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvoLara.mensagensEnviadas.some((m) => m.numero === tel))
    await new Promise((r2) => setTimeout(r2, 200))
  } finally {
    remover()
  }

  const envios = fakeEvoLara.mensagensEnviadas.filter((m) => m.numero === tel)
  assert.equal(envios.length, 1, 'a coluna ausente não pode causar um segundo envio real — só o registro local usa fallback')

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'o fallback precisa gravar a linha mesmo sem a coluna nova')
  assert.equal(saidas[0].mensagem, 'Resposta com coluna nova ausente')
})

test('nenhuma contaminação financeira — instance_name comercial nunca coincide com instância financeira cadastrada', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvoManual.setModo('ok')
  const leadId = await criarLeadDeTeste(tel)

  // Limpeza defensiva: whatsapp_instances é uma tabela EXCLUSIVAMENTE
  // financeira por contrato (ver comentário de cacheInstanciasFinanceiras em
  // src/lib/collection/whatsappInstances.js — "qualquer instance_name
  // cadastrado aqui É financeiro"), mas um achado pré-existente e já
  // documentado (whatsapp-instance-health-counters.test.mjs, sem cleanup)
  // pode vazar uma linha 'vivenzza' pra dentro dela quando os testes rodam
  // na mesma base compartilhada, o que não tem nenhuma relação com esta
  // correção. Remove qualquer vazamento antes de checar a pré-condição, pra
  // este teste ficar determinístico independente da ordem/isolamento de
  // outros arquivos de teste.
  await supabase.from('whatsapp_instances').delete().in('instance_name', [INSTANCIA_COMERCIAL_ESPERADA, 'vivenzza-teste-cloud'])

  const { data: instanciasFinanceiras, error } = await supabase.from('whatsapp_instances').select('instance_name')
  if (error) throw error
  assert.ok((instanciasFinanceiras ?? []).length > 0, 'pré-condição do teste: whatsapp_instances precisa ter ao menos a instância financeira semeada pela migration 20260101000029')
  const nomesFinanceiros = new Set(instanciasFinanceiras.map((i) => i.instance_name))
  assert.ok(!nomesFinanceiros.has(INSTANCIA_COMERCIAL_ESPERADA), 'pré-condição do teste: a instância comercial não pode estar cadastrada como financeira')

  const r = await chamarHttp(portaWhatsapp, 'POST', '/api/whatsapp/enviar', {
    token: tokenVendedor,
    body: { lead_id: leadId, numero: tel, mensagem: 'Mensagem 100% comercial' },
  })
  assert.equal(r.status, 200)

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1)
  assert.equal(saidas[0].instance_name, INSTANCIA_COMERCIAL_ESPERADA)
  assert.ok(!nomesFinanceiros.has(saidas[0].instance_name), 'instance_name gravado pelo fluxo comercial nunca pode coincidir com uma instância financeira cadastrada')
})
