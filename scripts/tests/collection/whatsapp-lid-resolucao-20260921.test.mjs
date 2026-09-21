// Continuação do incidente "WhatsApp/IA sem resposta" depois das PRs
// #111/#112: o sistema passou a descartar explicitamente mensagens
// comerciais cujo remoteJid termina em @lid e não traz remoteJidAlt (prova
// correta contra inventar telefone a partir dos dígitos do lid — commit
// 4fa14d8), mas isso ainda deixava o cliente sem resposta pra sempre, mesmo
// quando uma mensagem ANTERIOR do mesmo contato já tinha revelado o
// telefone real via remoteJidAlt.
//
// Pesquisa (2026-09-21) confirmou, com fontes públicas (issues do
// evolution-api, resposta oficial de mantenedor do Baileys em
// WhiskeySockets/Baileys#2551), que não existe endpoint read-only capaz de
// resolver um @lid nunca visto antes — a única via legítima é persistir,
// nós mesmos, o mapeamento lid->telefone nas ocasiões em que a Evolution já
// revelou os dois lados (remoteJidAlt presente), e reaproveitar esse cache
// em mensagens futuras do MESMO lid. Ver src/lib/whatsappLid.js.
//
// Esta suíte cobre, adversarialmente, os 5 cenários pedidos na continuação
// do incidente:
//   1. mapeado — remoteJidAlt confirma o telefone, grava o cache; mensagem
//      seguinte do MESMO lid sem remoteJidAlt reaproveita o cache e a Lara
//      responde normalmente (deixa de ser descarte).
//   2. não mapeado — @lid sem remoteJidAlt e sem cache prévio continua
//      sendo descarte fail-closed (comportamento da PR #111 preservado).
//   3. conflito — o mesmo lid aparece depois com um remoteJidAlt DIFERENTE:
//      a mensagem em si processa com a nova prova (é prova de primeira
//      mão), mas o cache NUNCA é sobrescrito — mensagem seguinte sem
//      remoteJidAlt continua resolvendo para o telefone original.
//   4. timeout — consulta ao cache artificialmente lenta não trava o
//      processamento: falha fechado dentro de um teto de tempo.
//   5. duplicidade/anti-loop — o mesmo evento entregue duas vezes (reentrega
//      de webhook) não duplica linha de cache, não duplica lead e não
//      dispara duas respostas da Lara (RATE_LIMIT_MS + evolution_id únicos
//      já cobrem isso — esta suíte só confirma que a resolução de @lid não
//      abre uma brecha nova).
//
// Escopo deliberadamente restrito a isto — não toca em DNC, handoff humano,
// separação financeiro/comercial (o motor financeiro nunca usa
// resolverTelefoneReal — ver webhook-handler.js) nem limites globais de
// envio. Nenhum envio real de WhatsApp — fakeEvolution/fakeAnthropic locais,
// banco Postgres local isolado (nunca 5432/5433/vivenzza_dev — ver
// LOCAL_PG_PORT/LOCAL_PG_DATABASE no comando de teste).
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
// Timeout curto SÓ pra teste (cenário 4) — produção continua com o default
// real (8000ms). Precisa ser definido ANTES do import de sdr.js/whatsappLid.js
// (lido como constante de módulo, mesmo padrão de sdr-timeout-verificacoes-
// 20260913.test.mjs).
process.env.SDR_QUERY_TIMEOUT_MS = '300'
delete process.env.EVOLUTION_WEBHOOK_TOKEN
delete process.env.ELEVENLABS_API_KEY

let supabase, server, porta, fakeEvo, fakeClaude

const AGORA_FORA_DO_HORARIO = new Date('2026-09-06T06:00:00.000Z')
const RATE_LIMIT_MS = 3000 // mesmo valor de src/routes/sdr.js — usado só pra saber quanto "tick" avançar entre mensagens do mesmo telefone dentro de um teste

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

  // Defesa contra estado vazado de OUTRO arquivo de teste (achado real,
  // 2026-09-21): whatsapp-instance-health-counters.test.mjs cadastra
  // 'vivenzza' em whatsapp_instances pra testar o denylist
  // INSTANCIAS_COMERCIAIS_PROIBIDAS e não limpa depois — como
  // `npm run test:collection` roda os arquivos em ordem alfabética contra o
  // mesmo Postgres, isso vaza pra este arquivo (que vem depois) e faz
  // ehInstanciaFinanceira('vivenzza') retornar true por engano, quebrando a
  // premissa desta suíte inteira (comercial, nunca financeiro). Bug de
  // isolamento de OUTRO arquivo, não corrigido aqui (fora de escopo — ver
  // CLAUDE.md "não misturar domínios"); esta suíte só garante sua própria
  // precondição, igual a qualquer outro teste que dependa de estado
  // compartilhado.
  await supabase.from('whatsapp_instances').delete().eq('instance_name', 'vivenzza')
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
  return `55519996${String(Date.now()).slice(-5)}${String(contador).padStart(2, '0')}`
}
function lidDeTeste() {
  contador++
  return `2${String(Date.now()).slice(-9)}${String(contador).padStart(3, '0')}`
}

function eventoBase({ key, message }) {
  const id = `FAKELID${Date.now()}${Math.random().toString(36).slice(2, 6)}`
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

// Mensagem de um contato @lid — remoteJidAlt opcional (undefined = a
// Evolution não revelou o telefone real nesta mensagem).
function eventoLid({ lid, telefoneAlt, texto, id }) {
  const key = { remoteJid: `${lid}@lid` }
  if (telefoneAlt) key.remoteJidAlt = `${telefoneAlt}@s.whatsapp.net`
  const evento = eventoBase({ key, message: { conversation: texto } })
  if (id) evento.data.key.id = id
  return evento
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

// registrarMapeamento (whatsappLid.js) é fire-and-forget em AMBOS os
// caminhos que chamam resolverTelefoneReal (processarLara em sdr.js E
// processWhatsappEvent em webhook-handler.js, sequenciais na mesma rota de
// webhook) — esperar só o envio da Lara (fakeEvo.mensagensEnviadas) não
// garante que a escrita em segundo plano já assentou. Usado entre passos
// que dependem do cache já estar gravado, pra não testar uma corrida em vez
// do comportamento real.
async function aguardarMapeamento(lid, telefoneEsperado, opts) {
  return aguardar(async () => {
    const { data } = await supabase.from('whatsapp_lid_telefone').select('telefone').eq('lid', lid).maybeSingle()
    return data?.telefone === telefoneEsperado ? data : null
  }, opts)
}

async function limparLid(lid) {
  await supabase.from('whatsapp_lid_telefone').delete().eq('lid', lid)
}
async function limparTelefone(telefone) {
  // webhook-handler.js grava leads.telefone SEM o prefixo "55" (`semPrefixo`
  // — só tira o código de país no INSERT do lead), mas whatsapp_mensagens/
  // sdr_conversas usam o telefone completo (com "55", vindo direto do JID)
  // — duas representações do mesmo contato em tabelas diferentes, já
  // existente no código de produção, não algo introduzido por este teste.
  await supabase.from('whatsapp_mensagens').delete().eq('telefone', telefone)
  await supabase.from('sdr_conversas').delete().eq('telefone', telefone)
  await supabase.from('leads').delete().eq('telefone', telefone.replace(/^55/, ''))
}
function telefoneSemPrefixo(telefone) {
  return telefone.replace(/^55/, '')
}

// Captura console.warn/console.error durante um trecho do teste — mesmo
// utilitário usado em sdr-silent-drop-regression-20260921.test.mjs, para
// checar o conteúdo sanitizado do log de descarte/conflito.
function capturarLogs(metodo) {
  const original = console[metodo]
  const capturados = []
  console[metodo] = (...args) => { capturados.push(args.join(' ')) }
  return { capturados, restaurar: () => { console[metodo] = original } }
}

// Intercepta a PRÓXIMA chamada supabase.from(tabela).<operacao>(...),
// atrasando a resolução real — mesma técnica de sdr-timeout-verificacoes-
// 20260913.test.mjs (atrasarProximaChamada), duplicada aqui pelo mesmo
// motivo que lá: cada arquivo de teste é independente.
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

const RE_CORRELATION_ID = /correlationId=([0-9a-f-]{36})/

test('1. mapeado: remoteJidAlt grava o cache; mensagem seguinte do mesmo lid sem remoteJidAlt reaproveita e a Lara responde (deixa de ser descarte)', async (t) => {
  const lid = lidDeTeste()
  const telefone = telefoneDeTeste()
  t.after(async () => { await limparLid(lid); await limparTelefone(telefone) })

  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Oi! primeira resposta via remoteJidAlt', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })
  const r1 = await chamarWebhook(eventoLid({ lid, telefoneAlt: telefone, texto: 'Oi, quero saber sobre os produtos' }))
  assert.equal(r1.status, 200)
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === telefone))
  const mapeamento = await aguardarMapeamento(lid, telefone)
  assert.ok(mapeamento, 'mapeamento lid->telefone precisa ter sido gravado após remoteJidAlt confirmado')

  const { data: mapeamentoCompleto } = await supabase.from('whatsapp_lid_telefone').select('*').eq('lid', lid).maybeSingle()
  assert.equal(mapeamentoCompleto.instance_name, 'vivenzza')

  mock.timers.tick(RATE_LIMIT_MS + 500) // sai da janela de rate-limit por telefone antes da 2ª mensagem

  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Oi de novo! resposta via cache do lid', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })
  const antesQtd = fakeEvo.mensagensEnviadas.filter((m) => m.numero === telefone).length
  const r2 = await chamarWebhook(eventoLid({ lid, texto: 'E sobre entrega, como funciona?' })) // sem remoteJidAlt desta vez
  assert.equal(r2.status, 200)
  await aguardar(async () => fakeEvo.mensagensEnviadas.filter((m) => m.numero === telefone).length > antesQtd)

  const mensagens = fakeEvo.mensagensEnviadas.filter((m) => m.numero === telefone)
  assert.equal(mensagens.length, 2, 'a 2ª mensagem (lid sem remoteJidAlt, resolvida via cache) precisa ter recebido resposta da Lara — não é mais descarte')
  assert.equal(mensagens[1].texto, 'Oi de novo! resposta via cache do lid')
})

test('2. não mapeado: @lid sem remoteJidAlt e sem cache prévio continua sendo descarte fail-closed (comportamento da PR #111 preservado)', async (t) => {
  const lid = lidDeTeste()
  t.after(async () => { await limparLid(lid) })

  const chamadasClaudeAntes = fakeClaude.chamadasRecebidas.length
  const { capturados, restaurar } = capturarLogs('warn')
  let r
  try {
    r = await chamarWebhook(eventoLid({ lid, texto: 'Primeira mensagem deste contato, nunca visto antes' }))
    assert.equal(r.status, 200)
    await new Promise((resolve) => setTimeout(resolve, 400)) // dá tempo pro processamento assíncrono (fire-and-forget) terminar ANTES de restaurar o console.warn original
  } finally {
    restaurar()
  }

  assert.equal(fakeClaude.chamadasRecebidas.length, chamadasClaudeAntes, 'Claude não pode ser chamado para um lid não resolvido')
  const { data: mapeamento } = await supabase.from('whatsapp_lid_telefone').select('*').eq('lid', lid).maybeSingle()
  assert.equal(mapeamento, null, 'nenhum mapeamento pode ser criado a partir de um lid nunca confirmado por remoteJidAlt')

  const logDescarte = capturados.find((m) => m.includes('[sdr:descarte]') && m.includes('motivo=lid_sem_remoteJidAlt'))
  assert.ok(logDescarte, `esperava log de descarte com motivo=lid_sem_remoteJidAlt..., logs capturados: ${JSON.stringify(capturados)}`)
  assert.match(logDescarte, RE_CORRELATION_ID, 'log de descarte precisa carregar correlationId')
  assert.ok(!logDescarte.includes(lid), 'log de descarte nunca pode conter o lid completo — só a versão mascarada')
})

test('3. conflito: o mesmo lid aparece depois com um remoteJidAlt diferente — a mensagem processa com a prova nova, mas o cache nunca é sobrescrito', async (t) => {
  const lid = lidDeTeste()
  const telefoneA = telefoneDeTeste()
  const telefoneB = telefoneDeTeste()
  t.after(async () => { await limparLid(lid); await limparTelefone(telefoneA); await limparTelefone(telefoneB) })

  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'resposta A', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })
  await chamarWebhook(eventoLid({ lid, telefoneAlt: telefoneA, texto: 'primeira mensagem, telefone A' }))
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === telefoneA))
  // Garante que a escrita fire-and-forget da 1ª mensagem (processarLara E
  // processWhatsappEvent chamam resolverTelefoneReal separadamente, cada um
  // com seu próprio registrarMapeamento em segundo plano) já assentou antes
  // de mandar a mensagem conflitante — sem isso, o teste vira uma corrida
  // entre a escrita da mensagem 1 e a da mensagem 2, não o cenário real.
  await aguardarMapeamento(lid, telefoneA)

  mock.timers.tick(RATE_LIMIT_MS + 500)

  const { capturados, restaurar } = capturarLogs('warn')
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'resposta B', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })
  let r2
  try {
    r2 = await chamarWebhook(eventoLid({ lid, telefoneAlt: telefoneB, texto: 'mesmo lid, agora com remoteJidAlt diferente' }))
    assert.equal(r2.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === telefoneB))
    // registrarMapeamento (whatsappLid.js) é fire-and-forget (não bloqueia a
    // resposta desta mensagem) — dá uma margem pra essa escrita em segundo
    // plano (e o log de conflito que ela pode gerar) terminar ANTES de
    // restaurar o console.warn original.
    await new Promise((resolve) => setTimeout(resolve, 400))
  } finally {
    restaurar()
  }
  // a mensagem em si tem prova de primeira mão (remoteJidAlt presente) — processa normalmente, sob telefoneB
  assert.ok(fakeEvo.mensagensEnviadas.some((m) => m.numero === telefoneB && m.texto === 'resposta B'))

  const logConflito = capturados.find((m) => m.includes('[whatsapp-lid:conflito]'))
  assert.ok(logConflito, `esperava log de conflito ao tentar gravar um telefone diferente para o mesmo lid, logs: ${JSON.stringify(capturados)}`)
  assert.ok(!logConflito.includes(telefoneA) && !logConflito.includes(telefoneB), 'log de conflito nunca pode conter telefone completo')

  const { data: mapeamento } = await supabase.from('whatsapp_lid_telefone').select('*').eq('lid', lid).maybeSingle()
  assert.equal(mapeamento.telefone, telefoneA, 'o cache precisa manter o PRIMEIRO telefone confirmado — nunca sobrescrever com um valor conflitante')

  mock.timers.tick(RATE_LIMIT_MS + 500)

  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'resposta via cache apos conflito', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })
  const antesQtdA = fakeEvo.mensagensEnviadas.filter((m) => m.numero === telefoneA).length
  await chamarWebhook(eventoLid({ lid, texto: 'terceira mensagem, sem remoteJidAlt' }))
  await aguardar(async () => fakeEvo.mensagensEnviadas.filter((m) => m.numero === telefoneA).length > antesQtdA)

  const paraA = fakeEvo.mensagensEnviadas.filter((m) => m.numero === telefoneA)
  assert.equal(paraA.length, 2, 'a 3ª mensagem (sem remoteJidAlt) precisa resolver pelo cache pro telefone ORIGINAL (A), não pro conflitante (B)')
  assert.equal(paraA[1].texto, 'resposta via cache apos conflito')
})

test('4. timeout: consulta ao cache artificialmente lenta não trava o processamento — falha fechado dentro de um teto de tempo', async (t) => {
  const lid = lidDeTeste()
  t.after(async () => { await limparLid(lid) })

  // 600ms de atraso > SDR_QUERY_TIMEOUT_MS (300ms, definido no topo do
  // arquivo) — sem abortSignal, isto travaria o turno inteiro.
  const remover = atrasarProximaChamada(supabase, { tabela: 'whatsapp_lid_telefone', operacao: 'select', delayMs: 900 })

  const { capturados, restaurar } = capturarLogs('warn')
  const inicio = Date.now()
  let r
  try {
    r = await chamarWebhook(eventoLid({ lid, texto: 'lid nunca visto, consulta ao cache vai travar' }))
    // Dá tempo do processamento assíncrono (fire-and-forget do handler) terminar,
    // sem esperar o atraso artificial inteiro de 900ms — mesmo teto (<2000ms) das
    // outras suítes de timeout deste projeto.
    await new Promise((resolve) => setTimeout(resolve, 1200))
  } finally {
    remover()
    restaurar()
  }
  const duracao = Date.now() - inicio

  assert.equal(r.status, 200) // o webhook sempre responde 200 de imediato pra Evolution, antes do processamento
  assert.ok(duracao < 2000, `esperava que o teto de espera limitasse o tempo total, levou ${duracao}ms`)

  const logDescarte = capturados.find((m) => m.includes('[sdr:descarte]') && (m.includes('motivo=timeout_consulta_cache') || m.includes('motivo=falha_consulta_cache')))
  assert.ok(logDescarte, `esperava descarte fail-closed por falha/timeout na consulta ao cache, logs: ${JSON.stringify(capturados)}`)

  const { data: mapeamento } = await supabase.from('whatsapp_lid_telefone').select('*').eq('lid', lid).maybeSingle()
  assert.equal(mapeamento, null, 'uma consulta que falhou/expirou não pode ter criado mapeamento nenhum')
})

test('5. duplicidade/anti-loop: o mesmo evento entregue duas vezes não duplica cache, lead nem resposta da Lara', async (t) => {
  const lid = lidDeTeste()
  const telefone = telefoneDeTeste()
  t.after(async () => { await limparLid(lid); await limparTelefone(telefone) })

  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'resposta única esperada', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const idFixo = `FAKELID-DUP-${Date.now()}`
  const evento = eventoLid({ lid, telefoneAlt: telefone, texto: 'mensagem que pode ser reentregue pela Evolution', id: idFixo })

  // Reentrega simulada: mesmo id de mensagem, mesmo lid/remoteJidAlt, entregue
  // de novo dentro da mesma janela de RATE_LIMIT_MS (relógio congelado) —
  // sequencial (não Promise.all) de propósito: reflete uma reentrega real de
  // webhook (retry após timeout, fila), não duas requisições disparadas no
  // mesmíssimo instante. Duas requisições literalmente simultâneas expõem uma
  // corrida SELECT-então-INSERT pré-existente em processWhatsappEvent
  // (webhook-handler.js) na criação de lead — não introduzida por esta
  // mudança (esta PR não toca nesse trecho) e fora de escopo aqui (ver
  // achado registrado separadamente); esta suíte testa que a RESOLUÇÃO de
  // @lid não abre uma brecha de duplicação nova, não que toda concorrência
  // bruta do sistema já seja livre de corrida.
  const r1 = await chamarWebhook(evento)
  assert.equal(r1.status, 200)
  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === telefone))
  await new Promise((resolve) => setTimeout(resolve, 300)) // dá tempo do processWhatsappEvent da 1ª entrega (lead/mensagem) terminar antes da reentrega

  const r2 = await chamarWebhook(evento)
  assert.equal(r2.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 500)) // sobra de margem pro processamento da reentrega (se houver) terminar

  const enviosParaTelefone = fakeEvo.mensagensEnviadas.filter((m) => m.numero === telefone)
  assert.equal(enviosParaTelefone.length, 1, 'reentrega do mesmo evento não pode disparar uma segunda resposta da Lara (RATE_LIMIT_MS)')

  const { data: mapeamentos } = await supabase.from('whatsapp_lid_telefone').select('*').eq('lid', lid)
  assert.equal(mapeamentos.length, 1, 'reentrega do mesmo evento não pode duplicar a linha de cache lid->telefone')

  const { data: mensagensEntrada } = await supabase.from('whatsapp_mensagens').select('id').eq('telefone', telefone).eq('direcao', 'entrada')
  assert.equal(mensagensEntrada.length, 1, 'reentrega do mesmo evolution_id não pode duplicar a mensagem de entrada (onConflict/ignoreDuplicates)')

  const { data: leads } = await supabase.from('leads').select('id').eq('telefone', telefoneSemPrefixo(telefone))
  assert.equal(leads.length, 1, 'reentrega do mesmo evento não pode criar um segundo lead pro mesmo telefone')
})
