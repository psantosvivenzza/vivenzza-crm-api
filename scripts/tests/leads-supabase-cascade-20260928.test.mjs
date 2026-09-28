// Regressão do incidente de produção de 2026-09-28: o host do Supabase
// respondeu com Cloudflare 522 (origem inalcançável) por um período, com
// respostas que chegavam a completar levando 90-300s. GET /api/leads —
// pollado (useLeadPolling, 30s) e refeito página-a-página a cada 30s pelo
// board (Pipeline.jsx refreshSilently), por cada aba aberta — continuou
// disparando consulta nova a cada requisição, cada uma esperando o tempo
// inteiro do Supabase antes de desistir. Isso empilhou dezenas de conexões
// concorrentes contra um backend já afogado, e webhooks da Evolution API
// expiraram porque o processo Node estava ocupado esperando essas chamadas.
//
// Este arquivo prova as três camadas de contenção implementadas em
// src/routes/leads.js de forma objetiva — contra Postgres local de verdade,
// não mocks —, sem esperar o timeout real inteiro em nenhum teste:
// 1. Timeout fail-fast (.abortSignal): uma chamada "lenta" (Supabase
//    simulado como travado) falha em LEADS_QUERY_TIMEOUT_MS, não no tempo
//    real que a operação levaria.
// 2. Circuit breaker (src/lib/circuitBreaker.js): depois de falhas
//    consecutivas, abre e passa a rejeitar SEM tocar o Supabase — provado
//    contando chamadas reais, não só olhando o resultado — e fecha de novo
//    sozinho quando o Supabase volta a responder (recuperação automática).
// 3. Cache curto + single-flight (src/lib/singleFlightCache.js): rajada
//    concorrente pro MESMO escopo+filtros gera 1 execução real só.
//
// "Supabase lento" é simulado monkey-patchando supabase.from('leads') pra
// atrasar a resolução por um tempo configurável ANTES de repassar pro
// pgCompatClient real — a query de verdade roda contra o Postgres local
// (rápida), só a ESPERA é atrasada artificialmente. Isso exercita o
// mecanismo real de `.abortSignal()` do pgCompatClient (mesma race contra o
// sinal que o Supabase real faz), sem depender de conseguir travar o
// Postgres local por um tempo determinístico.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-leads-cascade-nao-e-producao'

function adiar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Marca um instante ANTES de criar os leads de teste — usado como filtro
// `desde` em toda chamada deste arquivo, pra escopar a listagem só aos leads
// desta suíte. Necessário porque o Postgres local de teste é compartilhado
// entre suítes (mesmo cluster de `npm run test:collection`) e pode acumular
// leads de outras execuções — sem isso, `data.length` não é previsível.
let DESDE_MARCADOR = null

function chamar(porta, { token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    const inicio = Date.now()
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'GET', path: `/api/leads?pageSize=5&desde=${encodeURIComponent(DESDE_MARCADOR)}`, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({
        status: res.statusCode,
        body: chunks ? JSON.parse(chunks) : null,
        headers: res.headers,
        duracaoMs: Date.now() - inicio,
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

// Variante genérica (método + corpo JSON) — usada pelos testes 8/9 abaixo
// (POST duplicado / PUT sem permissão), que `chamar()` (só GET) não cobre.
function chamarJson(porta, { method = 'GET', path, token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json' }
    if (token) headers.authorization = `Bearer ${token}`
    const payload = body !== undefined ? JSON.stringify(body) : null
    const req = http.request({ host: '127.0.0.1', port: porta, method, path, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// Instala um atraso artificial em toda consulta supabase.from('leads') —
// simula "Supabase travado/lento" (Cloudflare 522) sem depender de travar o
// Postgres local por um tempo determinístico. A query real ainda roda contra
// o Postgres local (rápida) — só a resolução é adiada por `delayMs`, correndo
// contra `.abortSignal()` exatamente como o cliente real faria contra uma
// rede lenta de verdade.
function instalarSupabaseLento(supabase, delayMs) {
  const originalFrom = supabase.from.bind(supabase)
  let chamadasReais = 0

  supabase.from = (tabela) => {
    const builder = originalFrom(tabela)
    if (tabela !== 'leads') return builder
    chamadasReais++

    let signalCapturado = null
    const originalAbortSignal = builder.abortSignal.bind(builder)
    builder.abortSignal = (signal) => { signalCapturado = signal; return originalAbortSignal(signal) }

    const originalThen = builder.then.bind(builder)
    builder.then = (resolve, reject) => {
      return new Promise((res) => {
        const timer = setTimeout(res, delayMs)
        if (signalCapturado) {
          if (signalCapturado.aborted) { clearTimeout(timer); res() }
          else signalCapturado.addEventListener('abort', () => { clearTimeout(timer); res() }, { once: true })
        }
      }).then(() => originalThen(resolve, reject))
    }
    return builder
  }

  return {
    contagem: () => chamadasReais,
    restaurar: () => { supabase.from = originalFrom },
  }
}

async function subirApp(caseId) {
  const express = (await import('express')).default
  const leadsRouter = (await import(`../../src/routes/leads.js?case=${caseId}`)).default
  const { auth } = await import('../../src/middleware/auth.js')

  const app = express()
  app.use(express.json())
  app.use('/api/leads', auth, leadsRouter)

  const servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  return { servidor, porta: servidor.address().port }
}

const idsCriados = []
async function criarLeadDeTeste(supabase, sufixo) {
  const { data, error } = await supabase
    .from('leads')
    .insert({ nome: `Lead Cascade Teste ${sufixo}`, telefone: `5551988${String(Date.now()).slice(-6)}`, origem: 'manual' })
    .select('id')
    .single()
  if (error) throw error
  idsCriados.push(data.id)
  return data.id
}

test('GET /api/leads: contenção de cascata sob degradação do Supabase (incidente 2026-09-28)', async (t) => {
  const { supabase } = await import('../../src/lib/supabase-admin.server.js')
  const tokenAdmin = jwt.sign({ id: 'admin-teste-cascade', email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)

  DESDE_MARCADOR = new Date(Date.now() - 1000).toISOString()
  await criarLeadDeTeste(supabase, '1')
  await criarLeadDeTeste(supabase, '2')

  await t.test('1. timeout fail-fast: chamada "travada" falha em LEADS_QUERY_TIMEOUT_MS, não no tempo real da operação', async () => {
    process.env.LEADS_QUERY_TIMEOUT_MS = '150'
    process.env.LEADS_LIST_CACHE_TTL_MS = '10' // TTL curtíssimo — não deve interferir nas asserções de timeout/breaker deste bloco
    process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR = '100' // alto o bastante pra nunca abrir neste teste isolado
    const { servidor, porta } = await subirApp('timeout')
    const lento = instalarSupabaseLento(supabase, 5000) // "Supabase" simulado como travado por 5s

    try {
      const r = await chamar(porta, { token: tokenAdmin })
      assert.equal(r.status, 504, 'timeout deveria virar 504 (Gateway Timeout), não travar a resposta')
      assert.ok(r.duracaoMs < 1000, `resposta deveria voltar perto de 150ms (timeout configurado), levou ${r.duracaoMs}ms — travou esperando o "Supabase" lento`)
      assert.equal(lento.contagem(), 1, 'a chamada real ao Supabase deveria ter acontecido exatamente 1 vez')
    } finally {
      lento.restaurar()
      await new Promise((resolve) => servidor.close(resolve))
    }
  })

  await t.test('2-5. circuit breaker: abre depois de falhas consecutivas (rejeita SEM tocar o Supabase), fecha sozinho quando o Supabase volta', async () => {
    process.env.LEADS_QUERY_TIMEOUT_MS = '100'
    process.env.LEADS_LIST_CACHE_TTL_MS = '10'
    process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR = '3'
    process.env.LEADS_BREAKER_COOLDOWN_MS = '300'
    process.env.LEADS_BREAKER_COOLDOWN_MAX_MS = '300'
    const { servidor, porta } = await subirApp('breaker')
    const lento = instalarSupabaseLento(supabase, 5000)

    try {
      // 2. Falhas 1 e 2 (abaixo do limiar de 3): cada uma AINDA toca o Supabase de verdade.
      const r1 = await chamar(porta, { token: tokenAdmin })
      const r2 = await chamar(porta, { token: tokenAdmin })
      assert.equal(r1.status, 504)
      assert.equal(r2.status, 504)
      assert.equal(lento.contagem(), 2, 'as 2 primeiras falhas (abaixo do limiar) deveriam ter tocado o Supabase cada uma')

      // 3. Falha 3 cruza o limiar (falhasParaAbrir=3) — circuito abre.
      const r3 = await chamar(porta, { token: tokenAdmin })
      assert.equal(r3.status, 504, 'a própria falha que abre o circuito ainda reflete o erro real (timeout), não o circuito já aberto')
      assert.equal(lento.contagem(), 3)

      // 4. Circuito ABERTO: a 4ª chamada deveria rejeitar na hora, SEM tocar o Supabase.
      const r4 = await chamar(porta, { token: tokenAdmin })
      assert.equal(r4.status, 503, 'circuito aberto deveria responder 503 (Service Unavailable)')
      assert.ok(r4.headers['retry-after'], 'resposta de circuito aberto deveria incluir o header Retry-After')
      assert.ok(r4.duracaoMs < 80, `circuito aberto deveria rejeitar quase instantaneamente (sem esperar timeout nenhum), levou ${r4.duracaoMs}ms`)
      assert.equal(lento.contagem(), 3, 'chamada com circuito aberto NUNCA deveria tocar o Supabase — contagem real não pode ter aumentado')

      // 5. Depois do cooldown + Supabase saudável de novo: o circuito se recupera sozinho.
      lento.restaurar() // "Supabase" volta a responder normalmente (rápido)
      await adiar(350) // cooldown (300ms) + margem

      const r5 = await chamar(porta, { token: tokenAdmin })
      assert.equal(r5.status, 200, 'depois do cooldown, com o Supabase saudável, a próxima chamada (prova meio-aberta) deveria suceder e fechar o circuito')
      assert.equal(r5.body?.data?.length, 2, 'a listagem deveria voltar a trazer os leads reais depois da recuperação')

      const r6 = await chamar(porta, { token: tokenAdmin })
      assert.equal(r6.status, 200, 'circuito fechado de novo — chamadas seguintes continuam normais')
    } finally {
      lento.restaurar()
      await new Promise((resolve) => servidor.close(resolve))
    }
  })

  await t.test('6. cache curto + single-flight: rajada concorrente pro MESMO escopo+filtros gera 1 execução real só', async () => {
    process.env.LEADS_QUERY_TIMEOUT_MS = '5000'
    process.env.LEADS_LIST_CACHE_TTL_MS = '3000'
    process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR = '100'
    const { servidor, porta } = await subirApp('coalesce')
    const lento = instalarSupabaseLento(supabase, 200) // atraso — alarga a janela de corrida entre as chamadas concorrentes

    try {
      const N = 8
      const respostas = await Promise.all(Array.from({ length: N }, () => chamar(porta, { token: tokenAdmin })))

      for (const r of respostas) {
        assert.equal(r.status, 200, 'toda chamada concorrente deveria suceder (coalescida na mesma execução real)')
        assert.equal(r.body?.data?.length, 2)
      }
      assert.equal(lento.contagem(), 1, `${N} requisições HTTP concorrentes pro MESMO escopo+filtros deveriam coalescer numa única chamada real ao Supabase, mas houve ${lento.contagem()}`)
    } finally {
      lento.restaurar()
      await new Promise((resolve) => servidor.close(resolve))
    }
  })

  await t.test('7. escopos diferentes (filtros distintos) NUNCA coalescem entre si', async () => {
    process.env.LEADS_QUERY_TIMEOUT_MS = '5000'
    process.env.LEADS_LIST_CACHE_TTL_MS = '3000'
    process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR = '100'
    const { servidor, porta } = await subirApp('no-coalesce')
    const lento = instalarSupabaseLento(supabase, 150)

    try {
      const chamarComFiltro = (path) => new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: porta, method: 'GET', path, headers: { authorization: `Bearer ${tokenAdmin}` } }, (res) => {
          let chunks = ''
          res.on('data', (c) => { chunks += c })
          res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
        })
        req.on('error', reject)
        req.end()
      })

      const [a, b] = await Promise.all([
        chamarComFiltro('/api/leads?pageSize=5&page=1'),
        chamarComFiltro('/api/leads?pageSize=5&page=1&origem=manual'),
      ])
      assert.equal(a.status, 200)
      assert.equal(b.status, 200)
      assert.equal(lento.contagem(), 2, 'escopos com filtros diferentes precisam de execução própria — nunca podem compartilhar o resultado um do outro')
    } finally {
      lento.restaurar()
      await new Promise((resolve) => servidor.close(resolve))
    }
  })

  await t.test('8. erro de NEGÓCIO (409 telefone duplicado) NÃO conta como falha pro circuit breaker', async () => {
    // Achado de revisão adversarial da PR: o 409 de telefone duplicado era
    // lançado DE DENTRO de breakerLeads.executar() — o breaker não distingue
    // "Supabase falhou" de "a aplicação decidiu rejeitar", então cada 409
    // contava como falha. Sob uso normal (ex: webhook reenviando a mesma
    // mensagem), algumas tentativas de duplicidade em sequência abririam o
    // circuito e derrubariam TODO /api/leads (GET incluso) com o Supabase
    // 100% saudável — o próprio incidente que esta PR existe pra evitar,
    // autoinfligido por uma regra de negócio comum.
    process.env.LEADS_QUERY_TIMEOUT_MS = '5000'
    process.env.LEADS_LIST_CACHE_TTL_MS = '10'
    process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR = '2' // baixo de propósito
    const { servidor, porta } = await subirApp('business-409-nao-abre-breaker')

    // Fixture via insert direto (como criarLeadDeTeste), não via POST
    // HTTP: só precisamos que a checagem de duplicidade (SELECT id, nome —
    // colunas que sempre existem) encontre o telefone já cadastrado. Ir
    // pelo INSERT completo da rota dependeria de colunas do baseline local
    // de teste que não fazem parte deste achado (gap de ambiente, não do
    // circuit breaker sob teste aqui).
    const telefoneDuplicado = `5551977${String(Date.now()).slice(-6)}`
    const { data: fixture, error: erroFixture } = await supabase
      .from('leads')
      .insert({ nome: 'Lead Duplicidade Teste (fixture)', telefone: telefoneDuplicado, origem: 'manual' })
      .select('id')
      .single()
    if (erroFixture) throw erroFixture
    idsCriados.push(fixture.id)

    try {
      // Mais tentativas do que falhasParaAbrir (2) — se o 409 contasse como
      // falha, a 3ª tentativa já veria o circuito aberto (503), não 409.
      for (let i = 0; i < 4; i++) {
        const r = await chamarJson(porta, { method: 'POST', path: '/api/leads', token: tokenAdmin, body: { nome: 'Lead Duplicidade Teste', telefone: telefoneDuplicado } })
        assert.equal(r.status, 409, `tentativa ${i + 1} de telefone duplicado deveria continuar 409, nunca virar 503 (circuito aberto por engano)`)
      }

      // Prova final: uma leitura real ainda passa direto — circuito nunca
      // saiu de "fechado" por causa dos conflitos de negócio acima.
      const leitura = await chamar(porta, { token: tokenAdmin })
      assert.equal(leitura.status, 200, 'circuito deveria continuar fechado — 409 de negócio não é falha de infraestrutura')
    } finally {
      await new Promise((resolve) => servidor.close(resolve))
    }
  })

  await t.test('9. erro de AUTORIZAÇÃO (403 sem permissão) NÃO conta como falha pro circuit breaker', async () => {
    // Mesmo achado do teste 8, aplicado à checagem de posse (PUT /:id,
    // /:id/etapa, /:id/devolver-lara): um vendedor tentando editar lead
    // alheio é um 403 esperado sob uso normal (UI desatualizada, múltiplas
    // vendedoras no mesmo board) — não pode abrir o circuito.
    process.env.LEADS_QUERY_TIMEOUT_MS = '5000'
    process.env.LEADS_LIST_CACHE_TTL_MS = '10'
    process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR = '2' // baixo de propósito
    const { servidor, porta } = await subirApp('business-403-nao-abre-breaker')

    const tokenVendedorForasteiro = jwt.sign({ id: 'vendedor-forasteiro-teste', email: 'forasteiro@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
    const leadId = await criarLeadDeTeste(supabase, 'posse-403')

    try {
      // Mais tentativas do que falhasParaAbrir (2) — se o 403 contasse como
      // falha, a 3ª tentativa já veria o circuito aberto (503), não 403.
      for (let i = 0; i < 4; i++) {
        const r = await chamarJson(porta, { method: 'PUT', path: `/api/leads/${leadId}`, token: tokenVendedorForasteiro, body: { observacoes: 'tentativa indevida' } })
        assert.equal(r.status, 403, `tentativa ${i + 1} sem permissão deveria continuar 403, nunca virar 503 (circuito aberto por engano)`)
      }

      const leitura = await chamar(porta, { token: tokenAdmin })
      assert.equal(leitura.status, 200, 'circuito deveria continuar fechado — 403 de autorização não é falha de infraestrutura')
    } finally {
      await new Promise((resolve) => servidor.close(resolve))
    }
  })

  if (idsCriados.length) await supabase.from('leads').delete().in('id', idsCriados)
  delete process.env.LEADS_QUERY_TIMEOUT_MS
  delete process.env.LEADS_LIST_CACHE_TTL_MS
  delete process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR
  delete process.env.LEADS_BREAKER_COOLDOWN_MS
  delete process.env.LEADS_BREAKER_COOLDOWN_MAX_MS
})
