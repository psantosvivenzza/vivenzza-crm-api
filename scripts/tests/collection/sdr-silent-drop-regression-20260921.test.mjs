// Testes de regressão para os achados da auditoria de 2026-09-21 (job
// b264e419): 44/47 leads novas em 24h sem resposta da Lara, 14 nunca
// respondidas. Duas causas isoladas por leitura de código em
// src/routes/sdr.js: retorno silencioso quando o telefone não podia ser
// resolvido a partir de um remoteJid em formato @lid sem remoteJidAlt
// (linha ~839 antes desta correção) e retorno silencioso quando o texto
// extraído era só espaço/vazio (linha ~891 antes desta correção) — mais um
// caso real registrado com status_atendimento='ia_atendendo' sem nenhuma
// mensagem de saída correspondente e sem log de erro correlato.
//
// Esta suíte cobre, nesta ordem:
//   1. @lid sem remoteJidAlt -> o telefone real não é recuperável (é a
//      própria proteção de privacidade do "Linked ID" do WhatsApp) — isto
//      continua sendo um descarte, mas agora LOGADO (sanitizado, com
//      correlationId) em vez de silencioso, e sem processar sob uma
//      identidade fantasma (ver commit 4fa14d8, 2026-07-06, "evita leads
//      fantasma com IDs numéricos do Meta").
//   2. telefone vazio (remoteJid sem dígitos, não-@lid) -> mesmo tratamento.
//   3/4. texto e caption só-espaço -> ANTES descartados em silêncio; AGORA
//      usam o fallback de mensagem que já existia no código (ex:
//      "[Mensagem recebida]"), a Lara responde normalmente, sem duplicar.
//   5. status_atendimento='ia_atendendo' persiste mesmo quando o envio de
//      texto falha, e o log de erro carrega o MESMO correlationId do log
//      de decisão — fecha a lacuna de observabilidade do 3º achado, sem
//      mudar nenhum comportamento de fluxo nem adicionar reenvio.
//
// Escopo deliberadamente restrito a isto — não toca em anti-loop, handoff,
// DNC, separação financeiro/comercial, pacing nem limites globais (todos
// preservados; já cobertos por scripts/tests/collection/sdr-timeout-
// verificacoes-20260913.test.mjs e sdr-registrar-saida-erro.test.mjs).
// Nenhum envio real de WhatsApp — fakeEvolution/fakeAnthropic locais,
// nenhum dado real, banco Postgres local isolado (nunca 5432/5433/
// vivenzza_dev — ver LOCAL_PG_PORT/LOCAL_PG_DATABASE no comando de teste).
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
delete process.env.EVOLUTION_WEBHOOK_TOKEN
delete process.env.ELEVENLABS_API_KEY // fora de escopo — áudio nunca é exercitado aqui

let supabase, server, porta, fakeEvo, fakeClaude

// dentroDoHorarioComercial() usa o relógio real — congela num horário FORA
// do expediente (domingo de madrugada BRT), mesmo padrão já usado nas
// outras suítes de sdr.js, pra garantir que a Lara é exercitada de verdade.
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
  // Mesmo achado documentado nas outras suítes de sdr.js: o pool de conexão
  // interno do @anthropic-ai/sdk não é fechável a partir do teste.
  process.exit(process.exitCode ?? 0)
})

let contador = 0
function telefoneDeTeste() {
  contador++
  return `55519995${String(Date.now()).slice(-5)}${String(contador).padStart(2, '0')}`
}

function eventoBase({ key, message }) {
  const id = `FAKE${Date.now()}${Math.random().toString(36).slice(2, 6)}`
  return {
    event: 'messages.upsert',
    instance: 'vivenzza',
    data: {
      key: { fromMe: false, id, ...key },
      message,
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  }
}

function eventoTexto(telefone, texto) {
  return eventoBase({ key: { remoteJid: `${telefone}@s.whatsapp.net` }, message: { conversation: texto } })
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
async function buscarConversa(telefone) {
  const { data } = await supabase.from('sdr_conversas').select('*').eq('telefone', telefone).maybeSingle()
  return data
}
async function limpar(telefone) {
  await supabase.from('whatsapp_mensagens').delete().eq('telefone', telefone)
  await supabase.from('sdr_conversas').delete().eq('telefone', telefone)
  await supabase.from('leads').delete().eq('telefone', telefone)
}

function capturarConsole(metodo) {
  const capturados = []
  const original = console[metodo]
  const m = mock.method(console, metodo, (...args) => {
    capturados.push(args.map(String).join(' '))
    return original.apply(console, args)
  })
  return { capturados, restaurar: () => m.mock.restore() }
}

const RE_CORRELATION_ID = /correlationId=([0-9a-f-]{36})/

test('1. @lid sem remoteJidAlt: telefone real não recuperável — descarte agora logado (sanitizado, com correlationId), Claude/Evolution nunca chamados', async (t) => {
  fakeEvo.resetar()
  fakeClaude.resetar()
  const logsWarn = capturarConsole('warn')
  t.after(logsWarn.restaurar)

  // Dígito interno do "Linked ID" do Meta — parece um telefone, mas não é
  // (é exatamente o bug de 2026-07-06 que este teste garante que não volta).
  const lidFantasma = '182736451928374'
  const evento = eventoBase({ key: { remoteJid: `${lidFantasma}@lid` }, message: { conversation: 'Olá, quero saber sobre os produtos' } })

  const r = await chamarWebhook(evento)
  assert.equal(r.status, 200)
  await new Promise((res) => setTimeout(res, 400)) // tempo do processamento em background terminar

  assert.equal(fakeClaude.chamadasRecebidas.length, 0, 'Claude não pode ser chamado sem telefone real resolvido')
  assert.equal(fakeEvo.mensagensEnviadas.length, 0, 'nenhum envio pode acontecer sob uma identidade @lid não resolvida')

  const logDescarte = logsWarn.capturados.find((m) => m.includes('[sdr:descarte]') && m.includes('motivo=lid_sem_remoteJidAlt'))
  assert.ok(logDescarte, `esperava um log de descarte explícito para @lid sem remoteJidAlt (antes desta correção não havia NENHUM log aqui); capturado: ${JSON.stringify(logsWarn.capturados)}`)
  assert.match(logDescarte, RE_CORRELATION_ID, 'log de descarte precisa carregar um correlationId (UUID) pra permitir correlação futura')
  assert.ok(!logDescarte.includes(lidFantasma), 'log não pode conter o identificador @lid completo (só mascarado, últimos 4 dígitos)')
})

test('2. telefone vazio (remoteJid sem dígitos, não-@lid): mesmo tratamento — descarte logado, nenhum processamento', async (t) => {
  fakeEvo.resetar()
  fakeClaude.resetar()
  const logsWarn = capturarConsole('warn')
  t.after(logsWarn.restaurar)

  const evento = eventoBase({ key: { remoteJid: '@s.whatsapp.net' }, message: { conversation: 'Mensagem sem telefone extraível' } })
  const r = await chamarWebhook(evento)
  assert.equal(r.status, 200)
  await new Promise((res) => setTimeout(res, 400))

  assert.equal(fakeClaude.chamadasRecebidas.length, 0)
  assert.equal(fakeEvo.mensagensEnviadas.length, 0)

  const logDescarte = logsWarn.capturados.find((m) => m.includes('[sdr:descarte]') && m.includes('motivo=telefone_vazio'))
  assert.ok(logDescarte, `esperava log de descarte por telefone vazio (antes desta correção não havia NENHUM log aqui); capturado: ${JSON.stringify(logsWarn.capturados)}`)
  assert.match(logDescarte, RE_CORRELATION_ID)
})

test('3. texto só-espaço: achado real corrigido — antes descartada em silêncio, agora usa o fallback existente e responde (sem duplicar), e persiste ia_atendendo', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limpar(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Oi! Recebi sua mensagem, pode me contar mais?', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  // Só espaço/quebra de linha — truthy em JS (`if (texto)` antigo entrava
  // aqui), mas vazio depois do `.trim()` que decidia o descarte.
  const evento = eventoTexto(tel, '   \n  ')
  const r = await chamarWebhook(evento)
  assert.equal(r.status, 200)

  await aguardar(async () => fakeClaude.chamadasRecebidas.length > 0)
  const ultimaMensagemEnviadaAoClaude = fakeClaude.chamadasRecebidas[0].body.messages.at(-1)
  assert.equal(ultimaMensagemEnviadaAoClaude.content, '[Mensagem recebida]', 'fallback já existente no código precisa ser usado em vez de descartar a mensagem')

  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))
  const envios = fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel)
  assert.equal(envios.length, 1, 'exatamente uma resposta — a correção não pode gerar reenvio duplicado')

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 1, 'exatamente um registro de saída — sem duplicação')

  const conversa = await buscarConversa(tel)
  assert.equal(conversa?.status_atendimento, 'ia_atendendo', 'decisão da Lara precisa ficar persistida junto com o envio real')
})

test('4. caption de imagem só-espaço: usa o fallback de imagem em vez de descartar', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limpar(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Recebi sua imagem! Me conta o que você precisa em texto 😊', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const evento = eventoBase({
    key: { remoteJid: `${tel}@s.whatsapp.net` },
    message: { imageMessage: { caption: '   ', mimetype: 'image/jpeg' } },
  })
  const r = await chamarWebhook(evento)
  assert.equal(r.status, 200)

  await aguardar(async () => fakeClaude.chamadasRecebidas.length > 0)
  const ultimaMensagemEnviadaAoClaude = fakeClaude.chamadasRecebidas[0].body.messages.at(-1)
  assert.equal(
    ultimaMensagemEnviadaAoClaude.content,
    'O cliente enviou uma imagem. Responda que recebeu e peça para descrever o que precisa em texto.',
    'fallback de imagem já existente no código precisa ser usado quando a caption é só espaço'
  )

  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))
  assert.equal(fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel).length, 1, 'exatamente um envio — sem duplicação')
})

test('5. status_atendimento="ia_atendendo" persiste mesmo quando o envio de texto falha, com log de erro correlacionável ao log de decisão — sem reenvio automático', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limpar(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Esta resposta nunca vai ser aceita pela Evolution neste teste', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })
  fakeEvo.controlarInstancia('vivenzza', { comportamento: 'fail_explicit' }) // sendText sempre 400

  const logsLog = capturarConsole('log')
  const logsError = capturarConsole('error')
  t.after(() => { logsLog.restaurar(); logsError.restaurar() })

  const r = await chamarWebhook(eventoTexto(tel, 'Quero saber o preço do kit profissional'))
  assert.equal(r.status, 200)

  const conversa = await aguardar(async () => {
    const c = await buscarConversa(tel)
    return c?.status_atendimento === 'ia_atendendo' ? c : null
  })
  assert.equal(conversa.status_atendimento, 'ia_atendendo', 'decisão da Lara precisa ser persistida mesmo com falha no envio (achado real: caso órfão registrado em produção)')

  await new Promise((res) => setTimeout(res, 300)) // tempo do catch do envio terminar de logar

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 0, 'sem envio aceito pela Evolution, não pode existir registro de saída')

  const logDecisao = logsLog.capturados.find((m) => m.includes('[sdr:decisao]') && m.includes('status=ia_atendendo'))
  assert.ok(logDecisao, `esperava o log de decisão; capturado: ${JSON.stringify(logsLog.capturados)}`)
  const logErro = logsError.capturados.find((m) => m.includes('[sdr] erro ao enviar texto'))
  assert.ok(logErro, `esperava log de erro do envio de texto; capturado: ${JSON.stringify(logsError.capturados)}`)

  const correlationIdDecisao = logDecisao.match(RE_CORRELATION_ID)?.[1]
  const correlationIdErro = logErro.match(RE_CORRELATION_ID)?.[1]
  assert.ok(correlationIdDecisao, 'log de decisão precisa carregar correlationId')
  assert.ok(correlationIdErro, 'log de erro de envio precisa carregar correlationId')
  assert.equal(
    correlationIdErro, correlationIdDecisao,
    'decisão (ia_atendendo) e erro de envio precisam ser correlacionáveis pelo mesmo id — fecha a lacuna de observabilidade do achado "ia_atendendo sem saída"'
  )

  const errosDeEnvioDeTexto = logsError.capturados.filter((m) => m.includes('[sdr] erro ao enviar texto'))
  assert.equal(errosDeEnvioDeTexto.length, 1, 'exatamente UMA tentativa de envio de texto — nenhum reenvio automático após a falha')
})
