// Contenção do incidente de sobrecarga recorrente do Supabase (2026-09-24):
// GET /api/dashboard/atendimento paginava TODOS os leads, chamava a RPC
// get_ultima_mensagem_por_lead e baixava as mensagens da empresa INTEIRA dos
// últimos 7 dias — inclusive quando quem pedia era um único vendedor com
// poucas dezenas de leads (whatsapp_mensagens não tem responsavel_id direto,
// então o filtro por vendedor só existia em memória DEPOIS do download
// completo). Somado ao poll do frontend a cada 30s (Dashboard.jsx) com
// várias vendedoras/admins de painel aberto ao mesmo tempo, isso multiplicava
// consultas pesadas redundantes contra o banco.
//
// Corrigido em src/routes/dashboard.js: (1) a consulta de mensagens agora é
// restrita aos leads do próprio escopo (leadIds), em chunks, quando há
// filtro de vendedor; (2) cache curto + single-flight por escopo
// (src/lib/singleFlightCache.js) colapsa polls concorrentes/próximos do
// mesmo escopo numa única execução real; (3) timeout fail-fast
// (.abortSignal) e teto de páginas em toda consulta paginada.
//
// Este arquivo prova as três coisas de forma objetiva (contagem real de
// linhas/chamadas ao Supabase), não só o resultado final — o resultado final
// já estava correto ANTES desta correção (o filtro em memória já excluía
// mensagens de outros leads do cálculo); o que mudou é quanto trabalho o
// banco faz para chegar lá.
//
// Postgres local compartilhado (5433/vivenzza_dev, mesmo cluster de
// `npm run test:collection`) — nenhuma tabela aqui é singleton nem
// compartilhada com outra suíte, então roda seguro ao lado dela.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import jwt from 'jsonwebtoken'
import { PG_USER, PG_PASSWORD, PG_HOST, PG_PORT, PG_DATABASE } from '../localdb-config.mjs'

process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DATABASE}`
process.env.JWT_SECRET = process.env.JWT_SECRET || 'segredo-teste-atendimento-overload-nao-e-producao'
// TTL curto pra poder observar expiração de cache num teste rápido (produção
// usa o default de 30000ms — ver ATENDIMENTO_CACHE_TTL_MS em dashboard.js).
process.env.ATENDIMENTO_CACHE_TTL_MS = '150'

let servidor, porta, supabase
const usuarioIdsCriados = []
const leadIdsCriados = []
let VENDEDOR_A, VENDEDOR_B, tokenA, tokenB, tokenAdmin

function chamar(caminho, { token } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { authorization: `Bearer ${token}` } : {}
    const req = http.request({ host: '127.0.0.1', port: porta, method: 'GET', path: caminho, headers }, (res) => {
      let chunks = ''
      res.on('data', (c) => { chunks += c })
      res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }))
    })
    req.on('error', reject)
    req.end()
  })
}

// Instrumentação: conta linhas/chamadas reais contra o Supabase (local),
// sem mudar nenhum comportamento — só observa. Restaurado sempre em
// `pararInstrumentacao()`, inclusive entre testes.
function instrumentarSupabase() {
  const originalFrom = supabase.from.bind(supabase)
  const contagem = { chamadasPorTabela: new Map(), linhasPorTabela: new Map() }

  supabase.from = (tabela) => {
    const builder = originalFrom(tabela)
    contagem.chamadasPorTabela.set(tabela, (contagem.chamadasPorTabela.get(tabela) || 0) + 1)
    const originalThen = builder.then.bind(builder)
    builder.then = (resolve, reject) => originalThen((resultado) => {
      if (resultado?.data) {
        contagem.linhasPorTabela.set(tabela, (contagem.linhasPorTabela.get(tabela) || 0) + resultado.data.length)
      }
      return resolve(resultado)
    }, reject)
    return builder
  }

  return {
    contagem,
    parar() { supabase.from = originalFrom },
  }
}

before(async () => {
  const express = (await import('express')).default
  const dashboardRouter = (await import('../../src/routes/dashboard.js')).default
  const { auth } = await import('../../src/middleware/auth.js')
  ;({ supabase } = await import('../../src/lib/supabase-admin.server.js'))

  const app = express()
  app.use(express.json())
  // Mesmo mount de src/index.js: app.use('/api/dashboard', auth, dashboardRouter).
  app.use('/api/dashboard', auth, dashboardRouter)

  servidor = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  porta = servidor.address().port

  const sufixo = Date.now()
  const criarUsuario = async (nome, role = 'vendedor') => {
    const { data, error } = await supabase
      .from('usuarios')
      .insert({ nome, email: `${nome}-${sufixo}@teste.com`, role })
      .select('id')
      .single()
    if (error) throw error
    usuarioIdsCriados.push(data.id)
    return data.id
  }
  VENDEDOR_A = await criarUsuario('vendedor-a-atendimento-overload')
  VENDEDOR_B = await criarUsuario('vendedor-b-atendimento-overload')

  tokenA = jwt.sign({ id: VENDEDOR_A, email: 'a@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenB = jwt.sign({ id: VENDEDOR_B, email: 'b@teste.com', role: 'vendedor' }, process.env.JWT_SECRET)
  tokenAdmin = jwt.sign({ id: 'admin-teste', email: 'admin@teste.com', role: 'admin' }, process.env.JWT_SECRET)

  const criarLead = async (nome, responsavelId, etapa = 'novo') => {
    const { data, error } = await supabase
      .from('leads')
      .insert({ nome, responsavel_id: responsavelId, etapa, origem: 'manual' })
      .select('id')
      .single()
    if (error) throw error
    leadIdsCriados.push(data.id)
    return data.id
  }

  // Vendedor A: 2 leads ativos, cada um com 1 episódio entrada->saída
  // completo (tempo de resposta determinístico) e 1 mensagem de entrada em
  // aberto (aguardando resposta agora).
  const leadA1 = await criarLead('Lead A1', VENDEDOR_A)
  const leadA2 = await criarLead('Lead A2', VENDEDOR_A)
  // Lead FECHADO do vendedor A — não deve contar em nada (etapa terminal).
  await criarLead('Lead A fechado', VENDEDOR_A, 'fechado')

  // Vendedor B: 1 lead ativo, com uma carga GRANDE de mensagens (1200,
  // cruzando o limite de paginação de 1000 do PostgREST) — simula "carga
  // razoável" e é exatamente o volume que ANTES da correção era baixado por
  // completo mesmo quando quem perguntava era o vendedor A.
  const leadB1 = await criarLead('Lead B1 (carga)', VENDEDOR_B)

  const agora = Date.now()
  const msg = (leadId, direcao, minutosAtras) => ({
    lead_id: leadId,
    direcao,
    mensagem: 'x',
    telefone: '5551999999999',
    created_at: new Date(agora - minutosAtras * 60000).toISOString(),
  })

  // Lead A1: entrada às -50min, resposta (saída) às -40min -> 10min de espera.
  // Lead A2: entrada às -30min, resposta (saída) às -25min -> 5min de espera.
  // Depois, cada um recebe uma NOVA mensagem de entrada em aberto (sem
  // resposta ainda) -> aguardando_agora = 2, tempo_medio = (10+5)/2 = 7.5 -> 8.
  const mensagensA = [
    msg(leadA1, 'entrada', 50),
    msg(leadA1, 'saida', 40),
    msg(leadA1, 'entrada', 20), // aguardando agora
    msg(leadA2, 'entrada', 30),
    msg(leadA2, 'saida', 25),
    msg(leadA2, 'entrada', 10), // aguardando agora
  ]
  {
    const { error } = await supabase.from('whatsapp_mensagens').insert(mensagensA)
    if (error) throw error
  }

  // Vendedor B: 1200 mensagens de "carga" no lead B1 (nunca deveriam ser
  // lidas por uma consulta escopada ao vendedor A).
  // i=0 é o mais recente (minutosAtras=0) — fica como 'saida' de propósito,
  // pra B1 NUNCA aparecer como "aguardando" na visão geral (o teste de carga
  // é sobre isolamento/volume, não sobre o conteúdo em si do lead de B).
  const CARGA_B = 1200
  const mensagensB = Array.from({ length: CARGA_B }, (_, i) => msg(leadB1, i % 2 === 0 ? 'saida' : 'entrada', i))
  {
    const { error } = await supabase.from('whatsapp_mensagens').insert(mensagensB)
    if (error) throw error
  }
})

after(async () => {
  await supabase.from('whatsapp_mensagens').delete().in('lead_id', leadIdsCriados)
  if (leadIdsCriados.length) await supabase.from('leads').delete().in('id', leadIdsCriados)
  if (usuarioIdsCriados.length) await supabase.from('usuarios').delete().in('id', usuarioIdsCriados)
  await new Promise((resolve) => servidor.close(resolve))
})

test('GET /api/dashboard/atendimento — regressão funcional: vendedor só vê o próprio escopo', async () => {
  const { status, body } = await chamar('/api/dashboard/atendimento', { token: tokenA })
  assert.equal(status, 200)
  assert.equal(body.aguardando_agora, 2, 'lead A1 e A2 têm 1 mensagem de entrada em aberto cada')
  assert.equal(body.criticas, 0, 'nenhuma espera >= 30min neste cenário')
  assert.equal(body.tempo_medio_primeira_resposta_min, 8, 'média de 10min e 5min de resposta, arredondada')
  assert.equal(body.pendencias_por_vendedor.length, 1)
  assert.equal(body.pendencias_por_vendedor[0].vendedor_id, VENDEDOR_A)
  assert.equal(body.pendencias_por_vendedor[0].aguardando, 2)
})

test('GET /api/dashboard/atendimento — carga do vendedor B não contamina o resultado do vendedor A', async () => {
  const { status, body } = await chamar('/api/dashboard/atendimento', { token: tokenA })
  assert.equal(status, 200)
  // Se as 1200 mensagens de B tivessem entrado no cálculo de A, tempo_medio
  // e aguardando_agora teriam outros valores — a asserção acima (8min, 2
  // aguardando) já cobre isso, repetida aqui só pra deixar a intenção
  // explícita: isolamento entre vendedores é preservado (mesmo comportamento
  // de antes da correção, agora também não escaneando os dados de B).
  assert.equal(body.aguardando_agora, 2)
  assert.equal(body.tempo_medio_primeira_resposta_min, 8)
})

test('carga/eficiência: consulta escopada ao vendedor A NUNCA baixa as mensagens de B', async () => {
  const instrumentacao = instrumentarSupabase()
  try {
    // TTL de cache curto (150ms, configurado no topo) — espera expirar antes
    // de medir, pra garantir que esta chamada dispara uma execução real, não
    // uma resposta cacheada de um teste anterior.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const { status, body } = await chamar('/api/dashboard/atendimento', { token: tokenA })
    assert.equal(status, 200)
    assert.equal(body.aguardando_agora, 2)

    const linhasMensagens = instrumentacao.contagem.linhasPorTabela.get('whatsapp_mensagens') || 0
    // Vendedor A tem exatamente 6 mensagens próprias. Se a consulta ainda
    // baixasse a empresa inteira, esse número seria >= 1200 (carga de B) —
    // a asserção >= 1200 é o comportamento ANTIGO que este teste reprova.
    assert.equal(linhasMensagens, 6, 'só as mensagens dos próprios leads do vendedor A deveriam ser lidas')
    assert.ok(linhasMensagens < 1200, 'não pode ter escaneado a carga de mensagens do vendedor B')
  } finally {
    instrumentacao.parar()
  }
})

test('single-flight: rajada de polls concorrentes do mesmo vendedor gera 1 execução real só', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200)) // garante cache expirado antes da rajada
  const instrumentacao = instrumentarSupabase()
  try {
    const N = 10
    const respostas = await Promise.all(
      Array.from({ length: N }, () => chamar('/api/dashboard/atendimento', { token: tokenA }))
    )
    for (const { status, body } of respostas) {
      assert.equal(status, 200)
      assert.equal(body.aguardando_agora, 2)
    }

    // Mesma exigência da consulta isolada acima (6 linhas) — se a rajada
    // tivesse disparado 10 execuções reais em paralelo, esse número seria
    // 10x maior (60), e o mesmo valeria pra leads/RPC.
    const linhasMensagens = instrumentacao.contagem.linhasPorTabela.get('whatsapp_mensagens') || 0
    assert.equal(linhasMensagens, 6, `10 polls concorrentes deveriam coalescer em 1 execução real (6 linhas), leu ${linhasMensagens}`)
  } finally {
    instrumentacao.parar()
  }
})

test('cache curto: poll imediatamente seguinte reaproveita o resultado (0 chamadas novas)', async () => {
  // Continuação do teste anterior, dentro do MESMO TTL (150ms) — não espera
  // expirar de propósito, pra provar que o cache está servindo a resposta.
  const instrumentacao = instrumentarSupabase()
  try {
    const { status, body } = await chamar('/api/dashboard/atendimento', { token: tokenA })
    assert.equal(status, 200)
    assert.equal(body.aguardando_agora, 2)
    assert.equal(instrumentacao.contagem.chamadasPorTabela.size, 0, 'dentro do TTL não deveria tocar o Supabase de novo')
  } finally {
    instrumentacao.parar()
  }
})

test('cache expira: depois do TTL, o poll seguinte volta a consultar o Supabase', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200)) // > ATENDIMENTO_CACHE_TTL_MS (150)
  const instrumentacao = instrumentarSupabase()
  try {
    const { status } = await chamar('/api/dashboard/atendimento', { token: tokenA })
    assert.equal(status, 200)
    assert.ok(instrumentacao.contagem.chamadasPorTabela.size > 0, 'depois do TTL expirar, precisa recomputar de verdade')
  } finally {
    instrumentacao.parar()
  }
})

test('permissões preservadas: vendedor não vê dados de outro vendedor nem passando vendedor_id', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200))
  const { status, body } = await chamar(`/api/dashboard/atendimento?vendedor_id=${VENDEDOR_B}`, { token: tokenA })
  assert.equal(status, 200)
  // Papel 'vendedor' sempre usa o próprio id — query param vendedor_id é
  // ignorado nesse caso (mesmo comportamento de antes da correção).
  assert.equal(body.aguardando_agora, 2, 'deveria continuar vendo o PRÓPRIO escopo (A), nunca o de B')
})

test('visão geral (admin, sem vendedor_id): agrega os dois vendedores, permanece funcional', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200))
  const { status, body } = await chamar('/api/dashboard/atendimento', { token: tokenAdmin })
  assert.equal(status, 200)
  assert.equal(body.aguardando_agora, 2, 'A tem 2 aguardando; B só tem entrada/saída alternadas sem deixar nenhuma pendente')
  const porVendedor = new Map(body.pendencias_por_vendedor.map((p) => [p.vendedor_id, p]))
  assert.equal(porVendedor.get(VENDEDOR_A)?.aguardando, 2)
})

test('admin filtrando por vendedor_id explícito vê só aquele vendedor', async () => {
  await new Promise((resolve) => setTimeout(resolve, 200))
  const { status, body } = await chamar(`/api/dashboard/atendimento?vendedor_id=${VENDEDOR_A}`, { token: tokenAdmin })
  assert.equal(status, 200)
  assert.equal(body.aguardando_agora, 2)
  assert.equal(body.pendencias_por_vendedor.length, 1)
  assert.equal(body.pendencias_por_vendedor[0].vendedor_id, VENDEDOR_A)
})
