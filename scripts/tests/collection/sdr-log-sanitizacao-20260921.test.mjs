// Achado NÃO BLOQUEANTE da revisão adversarial da PR #111 (21/09/2026, já
// mergeada em origin/main): a PR #111 corrigiu os retornos silenciosos de
// processarLara() e adicionou um correlationId threading em vários logs
// (descartes, falhas de verificação/persistência, erro de Claude/áudio/
// catálogo), mas os logs `[sdr:debug]`/`[sdr:keyword]` PRÉ-EXISTENTES (não
// tocados pelo escopo daquela PR) continuavam logando o telefone completo do
// lead e, em dois pontos, conteúdo real da conversa — claudeRawText (resposta
// bruta da Claude) e o início de parsed.resposta (o texto que a Lara está
// prestes a mandar pro cliente). O log de erro de envio de texto também
// ganhou o correlationId na PR #111, mas continuou dumpando
// `textErr.response.data` bruto, que pode ecoar o payload da requisição
// (número + texto) em erros de validação reais da Evolution.
//
// Correção isolada, só de logging (nenhuma mudança de lógica de negócio,
// envio, handoff, DNC, pacing, flags ou credenciais), completando a
// disciplina de sanitização nesses pontos remanescentes:
// - telefone sempre mascarado (mascararTelefone, já usado em outros módulos
//   do motor de cobrança e já usado pela PR #111 no log de descarte) em todo
//   log que antes usava o valor bruto;
// - claudeRawText e parsed.resposta nunca mais aparecem em log — só
//   tamanhos (claudeRawLen/parsedRespostaLen), suficientes pra depurar sem
//   expor conteúdo;
// - parsearRespostaClaude (fallback de JSON inválido) loga só tamanho do
//   texto, nunca mais um trecho do próprio texto — e passa a receber o
//   mesmo correlationId do turno;
// - erro de envio de texto loga status HTTP + err.message (nunca mais inclui
//   o corpo bruto do payload de erro);
// - o log `[sdr:keyword]` passa a incluir o correlationId do turno, no mesmo
//   padrão já usado pelos outros logs desde a PR #111.
//
// Este arquivo prova adversarialmente, com telefone/mensagem/cartão/segredo
// 100% SINTÉTICOS (nunca dado real), que nada disso aparece em nenhum log
// emitido pelo fluxo da Lara — nem no caminho feliz (JSON válido), nem no
// fallback de JSON inválido, nem no log de keyword, nem quando o envio à
// Evolution falha e o erro ecoa o payload de volta — enquanto o
// comportamento funcional (a mensagem realmente enviada ao cliente) continua
// idêntico ao de antes da correção.
import { test, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
import { criarFakeEvolution } from '../fakes/fakeEvolution.js'
import { criarFakeAnthropic } from '../fakes/fakeAnthropic.js'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`
process.env.ANTHROPIC_API_KEY = 'fake-key-teste'
process.env.EVOLUTION_INSTANCE = 'vivenzza'
delete process.env.EVOLUTION_WEBHOOK_TOKEN // webhookAuth sem token configurado = skip (mesmo padrão de produção sem token)
delete process.env.ELEVENLABS_API_KEY // fora de escopo — este achado não toca o caminho de áudio

let supabase, server, porta, fakeEvo, fakeClaude

// dentroDoHorarioComercial() usa o relógio real — congela FORA do horário
// comercial pra garantir que a Lara responde de verdade (senão o fluxo nem
// chega perto dos logs sob teste, só marca "vendedor_assumiu" e sai; mesmo
// padrão já usado em sdr-timeout-verificacoes-20260913.test.mjs).
const AGORA_FORA_DO_HORARIO = new Date('2026-09-06T06:00:00.000Z') // domingo 03:00 BRT

const SEGREDO_SINTETICO = 'SEGREDO_SINTETICO_NAO_VAZAR_c2f8e1'
const CARTAO_SINTETICO = '4111-1111-1111-1111'

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

// Captura tudo que passaria por console.log/warn/error durante cada teste,
// sem deixar nada realmente escrever no terminal (evita poluir a saída da
// suíte com o próprio conteúdo sintético sob teste, e evita falso-positivo
// de "não vazou" só porque não olhamos pro stream certo).
let linhasLog = []
let originalLog, originalWarn, originalError
beforeEach(() => {
  linhasLog = []
  originalLog = console.log
  originalWarn = console.warn
  originalError = console.error
  console.log = (...args) => linhasLog.push(args.map(String).join(' '))
  console.warn = (...args) => linhasLog.push(args.map(String).join(' '))
  console.error = (...args) => linhasLog.push(args.map(String).join(' '))
})
afterEach(() => {
  console.log = originalLog
  console.warn = originalWarn
  console.error = originalError
})

function assertNenhumLogContem(...proibidos) {
  for (const linha of linhasLog) {
    for (const proibido of proibidos) {
      assert.ok(
        !linha.includes(proibido),
        `log não deveria conter "${proibido}", mas encontrado em: ${linha}`,
      )
    }
  }
}

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

async function limparLead(telefone) {
  await supabase.from('whatsapp_mensagens').delete().eq('telefone', telefone)
  await supabase.from('sdr_conversas').delete().eq('telefone', telefone)
  await supabase.from('leads').delete().eq('telefone', telefone)
}

test('processarLara (caminho feliz, JSON válido): nunca loga telefone completo, texto do cliente, claudeRawText nem a resposta da Lara — só metadados sanitizados', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()

  const mensagemCliente = `Meu cartão é ${CARTAO_SINTETICO} e minha senha é ${SEGREDO_SINTETICO}, meu telefone é ${tel}`
  // O texto que a Lara "responde" (gerado pela Claude fake) ecoa o mesmo
  // conteúdo sensível — simula um modelo real que repete de volta um dado
  // que o próprio cliente digitou, o pior caso pra um log de debug.
  const respostaLara = `Recebi: cartão ${CARTAO_SINTETICO}, senha ${SEGREDO_SINTETICO}, tel ${tel}`
  fakeClaude.controlar({
    texto: JSON.stringify({
      resposta: respostaLara,
      audio_script: null,
      acao: 'NENHUMA',
      tipo_lead: 'indefinido',
      proximo_estado: 'qualificando',
      temperatura: 'frio',
      etapa_cadencia: 1,
    }),
  })

  const r = await chamarWebhook(eventoTexto(tel, mensagemCliente))
  assert.equal(r.status, 200)
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))

  // Prova negativa: nada sensível em NENHUMA linha de log deste turno.
  assertNenhumLogContem(
    tel,
    CARTAO_SINTETICO,
    SEGREDO_SINTETICO,
    mensagemCliente,
    respostaLara,
  )

  // Prova positiva: os logs [sdr:debug] continuam existindo, são JSON válido,
  // usam telefone MASCARADO (só os 4 últimos dígitos reais) e carregam
  // correlationId + metadados (tamanhos/etapa/estado), não conteúdo.
  const linhasDebug = linhasLog.filter((l) => l.startsWith('[sdr:debug]'))
  assert.ok(linhasDebug.length >= 2, `esperava pelo menos 2 linhas [sdr:debug] (pré e pós-Claude), veio ${linhasDebug.length}`)

  const ultimos4 = tel.slice(-4)
  for (const linha of linhasDebug) {
    const json = JSON.parse(linha.replace('[sdr:debug] ', ''))
    assert.ok(typeof json.correlationId === 'string' && json.correlationId.length > 0, 'correlationId deveria estar presente')
    assert.match(json.tel, new RegExp(`^\\*+${ultimos4}$`), 'telefone deveria vir mascarado, terminando nos 4 últimos dígitos reais')
  }

  const debugPosClaude = linhasDebug.find((l) => l.includes('claudeRawLen'))
  assert.ok(debugPosClaude, 'esperava a linha [sdr:debug] pós-Claude, com claudeRawLen')
  const jsonPosClaude = JSON.parse(debugPosClaude.replace('[sdr:debug] ', ''))
  assert.equal(jsonPosClaude.claudeRawLen, JSON.stringify({
    resposta: respostaLara, audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido',
    proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1,
  }).length, 'claudeRawLen deveria refletir o tamanho real do texto bruto, mesmo sem expor o conteúdo')
  assert.equal(jsonPosClaude.parsedRespostaLen, respostaLara.length, 'parsedRespostaLen deveria refletir o tamanho real da resposta, mesmo sem expor o conteúdo')
  assert.ok(!('claudeRaw' in jsonPosClaude), 'campo claudeRaw (conteúdo bruto) não deveria mais existir')
  assert.ok(!('parsedRespostaStart' in jsonPosClaude), 'campo parsedRespostaStart (conteúdo) não deveria mais existir')

  // Preserva comportamento funcional: a mensagem realmente enviada ao
  // cliente continua sendo a resposta completa gerada pela Claude — a
  // correção é só de LOG, não de comportamento de envio.
  const envio = fakeEvo.mensagensEnviadas.find((m) => m.numero === tel)
  assert.equal(envio.texto, respostaLara)
})

test('processarLara (JSON inválido da Claude): fallback de parsearRespostaClaude nunca loga o conteúdo do texto bruto, só tamanho + correlationId — e ainda assim envia a mensagem ao cliente', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()

  // Claude retorna texto puro (sem JSON válido) contendo o segredo/cartão
  // diretamente — exercita o ramo `tryParse` falho de parsearRespostaClaude.
  const textoBrutoInvalido = `Não consegui processar isso em JSON, mas aqui vai: cartão ${CARTAO_SINTETICO}, senha ${SEGREDO_SINTETICO}`
  fakeClaude.controlar({ texto: textoBrutoInvalido })

  const r = await chamarWebhook(eventoTexto(tel, 'Mensagem qualquer do cliente'))
  assert.equal(r.status, 200)
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))

  assertNenhumLogContem(tel, CARTAO_SINTETICO, SEGREDO_SINTETICO, textoBrutoInvalido)

  const linhaFallback = linhasLog.find((l) => l.includes('parsearRespostaClaude: JSON inválido'))
  assert.ok(linhaFallback, 'esperava o log de fallback do parsing inválido')
  assert.match(linhaFallback, /correlationId=[0-9a-f-]{36}/, 'deveria incluir o correlationId do turno')
  assert.match(linhaFallback, /len=\d+/, 'deveria reportar o tamanho do texto, nunca o texto em si')

  // Comportamento funcional preservado: mesmo com JSON inválido, o texto
  // puro ainda vira a resposta e é efetivamente enviado ao cliente — a
  // correção não muda essa lógica de fallback, só o que é logado sobre ela.
  const envio = fakeEvo.mensagensEnviadas.find((m) => m.numero === tel)
  assert.equal(envio.texto, textoBrutoInvalido)
})

test('processarLara (keyword B2B/B2C): [sdr:keyword] usa telefone mascarado e nunca loga o texto livre do cliente, só a keyword fixa da lista', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({
    texto: JSON.stringify({
      resposta: 'Perfeito, me conta mais sobre sua distribuição.',
      audio_script: null, acao: 'NENHUMA', tipo_lead: 'distribuidor',
      proximo_estado: 'qualificando', temperatura: 'morno', etapa_cadencia: 2,
    }),
  })

  const mensagemCliente = `Sou distribuidor, cartão ${CARTAO_SINTETICO}, segredo ${SEGREDO_SINTETICO}, tel ${tel}`
  const r = await chamarWebhook(eventoTexto(tel, mensagemCliente))
  assert.equal(r.status, 200)
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))

  const linhaKeyword = linhasLog.find((l) => l.startsWith('[sdr:keyword]'))
  assert.ok(linhaKeyword, 'esperava a linha [sdr:keyword] (mensagem contém keyword B2B "distribui")')
  assert.match(linhaKeyword, /correlationId|[0-9a-f]{8}-[0-9a-f]{4}/, 'deveria conter o correlationId do turno')
  assert.match(linhaKeyword, new RegExp(`tel=\\*+${tel.slice(-4)}$|tel=\\*+${tel.slice(-4)}\\s`), 'telefone deveria vir mascarado no log de keyword')
  assert.ok(linhaKeyword.includes('keyword="distribui"'), 'deveria logar a keyword FIXA da lista (KEYWORDS_B2B), não o texto do cliente')
  assert.ok(!linhaKeyword.includes(tel), 'log de keyword não pode conter o telefone completo')
  assert.ok(!linhaKeyword.includes(CARTAO_SINTETICO) && !linhaKeyword.includes(SEGREDO_SINTETICO), 'log de keyword não pode conter conteúdo do cliente')

  assertNenhumLogContem(tel, CARTAO_SINTETICO, SEGREDO_SINTETICO, mensagemCliente)
})

test('processarLara (erro de envio que ecoa o payload): "[sdr] erro ao enviar texto" nunca loga o corpo bruto do erro — só status HTTP + correlationId', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()

  const respostaComSegredo = `Sua senha cadastrada é ${SEGREDO_SINTETICO} e o cartão final é ${CARTAO_SINTETICO}`
  fakeClaude.controlar({
    texto: JSON.stringify({
      resposta: respostaComSegredo,
      audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido',
      proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1,
    }),
  })
  // A Evolution responde com erro de validação que ECOA o payload da
  // requisição (número + texto) no corpo — cenário real que motivou a
  // correção (antes: `JSON.stringify(textErr.response.data)` no log).
  fakeEvo.controlarInstancia('vivenzza', { comportamento: 'echo_payload_error' })

  const r = await chamarWebhook(eventoTexto(tel, 'Mensagem que vai gerar erro de envio'))
  assert.equal(r.status, 200)

  const linhaErro = await aguardar(async () => linhasLog.find((l) => l.includes('[sdr] erro ao enviar texto')))
  assert.ok(linhaErro, 'esperava o log de erro de envio de texto')
  assert.match(linhaErro, /correlationId=[0-9a-f-]{36}/, 'deveria incluir o correlationId do turno')
  assert.match(linhaErro, /status=400/, 'deveria reportar o status HTTP do erro')

  assertNenhumLogContem(tel, CARTAO_SINTETICO, SEGREDO_SINTETICO, respostaComSegredo, 'payload ecoado')

  // Nenhuma mensagem foi de fato registrada como enviada (a Evolution
  // recusou) — comportamento funcional de erro preservado, sem reenvio
  // automático nem mascaramento de que a falha aconteceu.
  assert.equal(fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel).length, 0)
})
