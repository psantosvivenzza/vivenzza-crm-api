// PR candidata reduzida: só a correção de registrarMensagemSaida() em
// src/routes/sdr.js (checagem explícita de `error` no select de leads e no
// insert de whatsapp_mensagens, antes ignorados em silêncio) + log
// sanitizado distinguindo falha de REGISTRO local de falha de ENVIO.
//
// ESCOPO DELIBERADAMENTE ESTREITO — o que este arquivo NÃO cobre, de
// propósito, fica preservado para revisão separada em
// vivenzza-whatsapp-incident (worktree próprio, mesmo pedido original):
// timeouts (.abortSignal), mudanças de pacing, decisões de config/handoff/
// anti-loop, comportamento após falha ao salvar sdr_conversas. Os testes de
// handoff humano abaixo exercitam o código EXISTENTE e NÃO MODIFICADO dessa
// checagem (só pra confirmar que o cenário de sucesso/erro de
// registrarMensagemSaida não depende de uma consulta de handoff falhando).
//
// Correção de descrição: o defeito de tratamento de erro corrigido aqui é
// comprovado por leitura do código (o `error` nunca era checado). NÃO foi
// demonstrado que este defeito causou algum caso histórico real de
// mensagem sem registro — a amostra investigada, ao ser reconciliada
// diretamente com a Evolution (fonte independente), mostrou que as
// mensagens foram entregues. Entrega confirmada pela Evolution e
// persistência no CRM local são evidências DIFERENTES; uma não prova a
// outra — por isso os testes de sucesso/erro abaixo verificam os dois
// fatos separadamente (envio real do lado da Evolution + estado da linha
// local).
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
delete process.env.EVOLUTION_WEBHOOK_TOKEN // webhookAuth sem token configurado = skip (mesmo padrão de produção sem token)
delete process.env.ELEVENLABS_API_KEY // fora de escopo — áudio nunca é exercitado aqui

let supabase, server, porta, fakeEvo, fakeClaude

// dentroDoHorarioComercial() usa o relógio real do sistema (mudar isso está
// fora do escopo desta PR: nenhuma decisão de config/handoff/horário é
// tocada aqui) — congela SÓ o Date pra garantir que o teste exercita o
// caminho de resposta da Lara independente da hora real de quando rodar,
// sem alterar src/routes/sdr.js.
const AGORA_FORA_DO_HORARIO = new Date('2026-09-06T06:00:00.000Z') // domingo 03:00 BRT

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
  // Mesmo achado documentado na investigação completa (worktree
  // vivenzza-whatsapp-incident): o pool de conexão interno do
  // @anthropic-ai/sdk não é fechável a partir do teste. Todas as asserções
  // já rodaram e foram reportadas antes deste ponto.
  process.exit(process.exitCode ?? 0)
})

let contador = 0
function telefoneDeTeste() {
  contador++
  return `55519998${String(Date.now()).slice(-5)}${String(contador).padStart(2, '0')}`
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

// Cria o lead ANTES do webhook rodar, com atendimento_humano EXPLÍCITO —
// item pedido nesta revisão: os testes de sucesso/erro do registro local
// não podem depender da consulta de handoff falhar/estar ausente pra
// prosseguir. Com o lead já existindo e atendimento_humano=false, a
// checagem de handoff (código não modificado nesta PR) roda de verdade,
// encontra o lead, e conclui "sem handoff" pelo valor real da coluna — não
// por uma consulta que erra e é silenciosamente ignorada.
async function criarLeadDeTeste(telefone, { atendimentoHumano = false } = {}) {
  const { error } = await supabase.from('leads').insert({
    nome: `Lead teste ${telefone}`, telefone, etapa: 'novo', origem: 'whatsapp',
    campanha_origem: 'whatsapp_organico', atendimento_humano: atendimentoHumano,
  })
  if (error) throw error
}

// Intercepta a PRÓXIMA chamada supabase.from(tabela).<operacao>(...) — a
// N-ésima ocorrência dela (default: a primeira) — substituindo o resultado
// por um erro simulado, sem quebrar o encadeamento. `ocorrencia` existe
// porque registrarMensagemSaida faz um SELECT em `leads` que tem a MESMA
// forma (tabela+operação) do SELECT de handoff em processarLara, que roda
// antes — sem contar ocorrências não dá pra mirar só o segundo.
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

test('baseline: lead com atendimento_humano=false explícito — Evolution aceita e o registro local funciona normalmente', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: false })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Oi! Tudo bem?', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const r = await chamarWebhook(eventoTexto(tel, 'Olá'))
  assert.equal(r.status, 200)

  await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))
  const saidas = await aguardar(async () => { const s = await buscarMensagensSaida(tel); return s.length > 0 ? s : null })
  assert.equal(saidas.length, 1, 'caminho feliz precisa continuar registrando normalmente')
  assert.equal(saidas[0].mensagem, 'Oi! Tudo bem?')
})

test('atendimento_humano=true (checagem de handoff existente, não modificada) → nenhum envio', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: true })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'ISTO NUNCA deveria ser enviado', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const r = await chamarWebhook(eventoTexto(tel, 'Mensagem com handoff humano ativo'))
  assert.equal(r.status, 200)
  await new Promise((r2) => setTimeout(r2, 500)) // dá tempo do processamento em background terminar

  assert.equal(fakeClaude.chamadasRecebidas.length, 0, 'Claude nem deveria ser chamado — handoff humano bloqueia antes disso (código existente, não alterado nesta PR)')
  assert.equal(fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel).length, 0)
  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 0)
})

test('Evolution aceita o envio, mas o insert local falha — erro registrado e NENHUM reenvio (achado real corrigido)', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: false })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Mensagem enviada de verdade, insert local falha', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const errosCapturados = []
  const consoleErrorOriginal = console.error
  const mockConsoleError = mock.method(console, 'error', (...args) => {
    errosCapturados.push(args.map(String).join(' '))
    return consoleErrorOriginal.apply(console, args)
  })

  const remover = interceptarChamada(supabase, {
    tabela: 'whatsapp_mensagens', operacao: 'insert',
    erroSimulado: { message: 'coluna inexistente (simulado)', code: '42703' },
  })
  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Testando insert falhando'))
    assert.equal(r.status, 200)
    // PROVA 1 (entrega/aceite pela Evolution — fonte independente da nossa
    // tabela): o envio realmente chegou lá, apesar do insert local falhar.
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))
    // Dá tempo do catch de registrarMensagemSaida terminar de logar, depois
    // do envio já confirmado (evita corrida entre a asserção e o log).
    await new Promise((r2) => setTimeout(r2, 200))
  } finally {
    remover()
    mockConsoleError.mock.restore()
  }

  // UM ÚNICO envio à Evolution — a falha de registro local não pode ter
  // disparado nenhuma tentativa adicional (nenhum reenvio automático).
  const envios = fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel)
  assert.equal(envios.length, 1, 'a falha no registro local não pode gerar um segundo envio — nenhum reenvio automático')
  assert.equal(envios[0].texto, 'Mensagem enviada de verdade, insert local falha')

  // Erro EXPLÍCITO e SANITIZADO (sem conteúdo de mensagem/telefone completo
  // no texto fixo do log), distinguindo claramente REGISTRO de ENVIO.
  const logDeErro = errosCapturados.find((m) => m.includes('falha ao REGISTRAR mensagem de saída'))
  assert.ok(logDeErro, `esperava um log de erro explícito sobre a falha de REGISTRO local; capturado: ${JSON.stringify(errosCapturados)}`)
  assert.ok(logDeErro.includes('ENVIO'), 'o log precisa deixar explícito que o ENVIO (à Evolution) é uma etapa separada, já concluída')
  assert.ok(!logDeErro.includes(tel), 'log não pode conter o telefone completo')
  assert.ok(!logDeErro.includes('Mensagem enviada de verdade'), 'log não pode conter o conteúdo da mensagem')

  // PROVA 2 (persistência no CRM — evidência DIFERENTE da entrega): a linha
  // realmente não existe localmente, mesmo com o envio real confirmado do
  // lado da Evolution. Ausência de whatsapp_mensagens não prova ausência de
  // envio — as duas evidências são checadas separadamente neste teste.
  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 0, 'registro local realmente ausente — é exatamente isto que o defeito corrigido permitia acontecer em silêncio')
})

test('Evolution aceita o envio, mas o SELECT de leads dentro de registrarMensagemSaida falha — erro registrado e NENHUM reenvio', async (t) => {
  const tel = telefoneDeTeste()
  t.after(() => limparLead(tel))
  fakeEvo.resetar()
  fakeClaude.resetar()
  await criarLeadDeTeste(tel, { atendimentoHumano: false })
  fakeClaude.controlar({ texto: JSON.stringify({ resposta: 'Mensagem enviada de verdade, select de leads falha', audio_script: null, acao: 'NENHUMA', tipo_lead: 'indefinido', proximo_estado: 'qualificando', temperatura: 'frio', etapa_cadencia: 1 }) })

  const errosCapturados = []
  const consoleErrorOriginal = console.error
  const mockConsoleError = mock.method(console, 'error', (...args) => {
    errosCapturados.push(args.map(String).join(' '))
    return consoleErrorOriginal.apply(console, args)
  })

  // ocorrencia:2 — a 1ª leitura de 'leads' é a checagem de handoff em
  // processarLara (roda antes, precisa continuar funcionando normalmente:
  // o lead já existe e atendimento_humano=false, então passa); a 2ª é a
  // leitura dentro de registrarMensagemSaida (usada só pra achar o lead_id
  // do insert em whatsapp_mensagens) — é essa que este teste força a falhar.
  const remover = interceptarChamada(supabase, {
    tabela: 'leads', operacao: 'select', ocorrencia: 2,
    erroSimulado: { message: 'timeout simulado no select de leads' },
  })
  try {
    const r = await chamarWebhook(eventoTexto(tel, 'Testando select de leads falhando'))
    assert.equal(r.status, 200)
    await aguardar(async () => fakeEvo.mensagensEnviadas.some((m) => m.numero === tel))
    await new Promise((r2) => setTimeout(r2, 200))
  } finally {
    remover()
    mockConsoleError.mock.restore()
  }

  const envios = fakeEvo.mensagensEnviadas.filter((m) => m.numero === tel)
  assert.equal(envios.length, 1, 'a falha no select de leads dentro do registro local não pode gerar um segundo envio')
  assert.equal(envios[0].texto, 'Mensagem enviada de verdade, select de leads falha')

  const logDeErro = errosCapturados.find((m) => m.includes('falha ao REGISTRAR mensagem de saída'))
  assert.ok(logDeErro, `esperava um log de erro explícito sobre a falha de REGISTRO local; capturado: ${JSON.stringify(errosCapturados)}`)
  assert.ok(!logDeErro.includes(tel), 'log não pode conter o telefone completo')

  const saidas = await buscarMensagensSaida(tel)
  assert.equal(saidas.length, 0, 'select de leads falhou antes do insert — nenhuma linha de saída chega a ser gravada')
})
