// IA WhatsApp MVP — worker local: autenticação fail-closed, fila com lease
// anti-corrida, resultado sempre passa pela MESMA validação/guardrail do
// caminho direto (nunca confia no worker), fail-safe em JSON inválido, e
// prova estática de que nada aqui fala com Evolution/SQL/segredo.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')

process.env.AI_PROVIDER = 'mock'

test('aiWorkerAuth: fail-closed, token dedicado', async (t) => {
  const { aiWorkerAuth } = await import('../../../src/middleware/aiWorkerAuth.js')

  function mockReqRes(token) {
    const req = { headers: token !== undefined ? { 'x-ai-worker-token': token } : {}, ip: '127.0.0.1' }
    let statusCode = null
    let body = null
    const res = { status(c) { statusCode = c; return this }, json(b) { body = b; return this } }
    let nextChamado = false
    const next = () => { nextChamado = true }
    return { req, res, next, get statusCode() { return statusCode }, get body() { return body }, get nextChamado() { return nextChamado } }
  }

  await t.test('A. AI_WORKER_TOKEN não configurado -> 503, nunca deixa passar', () => {
    delete process.env.AI_WORKER_TOKEN
    const m = mockReqRes('qualquer-coisa')
    aiWorkerAuth(m.req, m.res, m.next)
    assert.equal(m.statusCode, 503)
    assert.equal(m.nextChamado, false)
  })

  await t.test('B. Token configurado, header ausente ou errado -> 401', () => {
    process.env.AI_WORKER_TOKEN = 'segredo-do-worker-123'
    const semHeader = mockReqRes(undefined)
    aiWorkerAuth(semHeader.req, semHeader.res, semHeader.next)
    assert.equal(semHeader.statusCode, 401)
    assert.equal(semHeader.nextChamado, false)

    const errado = mockReqRes('token-errado')
    aiWorkerAuth(errado.req, errado.res, errado.next)
    assert.equal(errado.statusCode, 401)
    assert.equal(errado.nextChamado, false)
  })

  await t.test('C. Token correto -> next() chamado, sem resposta de erro', () => {
    process.env.AI_WORKER_TOKEN = 'segredo-do-worker-123'
    const m = mockReqRes('segredo-do-worker-123')
    aiWorkerAuth(m.req, m.res, m.next)
    assert.equal(m.nextChamado, true)
    assert.equal(m.statusCode, null)
  })
})

test('Fila de jobs + resultado do worker (código real, Postgres local)', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { enfileirarJob, proximoJobDisponivel, buscarJob } = await import('../../../src/lib/collection/ai/jobQueue.js')
  const { aplicarResultadoDoWorker } = await import('../../../src/lib/collection/ai/workerResult.js')

  await t.test('D. Job enfileirado aparece em proximoJobDisponivel, vira leased', async () => {
    await supabase.from('ai_jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000')
    const conta = await criarContaDeTeste(supabase)
    const job = await enfileirarJob({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'quero pagar' })
    assert.equal(job.status, 'pending')

    const leased = await proximoJobDisponivel()
    assert.equal(leased.id, job.id)
    assert.equal(leased.status, 'leased')

    const releido = await buscarJob(job.id)
    assert.equal(releido.status, 'leased')
  })

  await t.test('E. Duas chamadas concorrentes a proximoJobDisponivel nunca arrendam o MESMO job pras duas', async () => {
    const conta = await criarContaDeTeste(supabase)
    await enfileirarJob({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'manda o pix' })

    const [a, b] = await Promise.all([proximoJobDisponivel(), proximoJobDisponivel()])
    const vencedores = [a, b].filter(Boolean)
    assert.equal(vencedores.length, 1, 'só uma das duas chamadas concorrentes deveria vencer a corrida do lease')
  })

  await t.test('F. Resultado válido do worker -> suggestion criada, job done, mesmas regras do caminho direto', async () => {
    const conta = await criarContaDeTeste(supabase)
    const job = await enfileirarJob({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'esse valor está errado' })
    await proximoJobDisponivel()

    const registro = await aplicarResultadoDoWorker(job, {
      rawClassifyResponse: JSON.stringify({ intent: 'CONTESTA_VALOR', confidence: 'alta', cliente_irritado: false }),
      rawGenerateResponse: JSON.stringify({ suggested_reply: 'Vamos verificar.', extracted_date: null }),
    })

    assert.equal(registro.intent, 'CONTESTA_VALOR')
    assert.equal(registro.requires_human, true, 'CONTESTA_VALOR sempre exige humano, igual ao caminho direto')

    const jobFinal = await buscarJob(job.id)
    assert.equal(jobFinal.status, 'done')
    assert.equal(jobFinal.suggestion_id, registro.id)
  })

  await t.test('G. JSON inválido do worker -> fail-safe: ainda gera suggestion (UNKNOWN, requires_human=true), job continua done (não trava em failed)', async () => {
    const conta = await criarContaDeTeste(supabase)
    const job = await enfileirarJob({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'texto qualquer' })
    await proximoJobDisponivel()

    const registro = await aplicarResultadoDoWorker(job, {
      rawClassifyResponse: 'isso não é um JSON válido',
      rawGenerateResponse: 'nem isso',
    })

    assert.equal(registro.intent, 'UNKNOWN')
    assert.equal(registro.requires_human, true)
    assert.ok(registro.reason_codes.includes?.('json_invalido_do_llm') || Object.values(registro.reason_codes).includes('json_invalido_do_llm'))

    const jobFinal = await buscarJob(job.id)
    assert.equal(jobFinal.status, 'done', 'fail-safe produz uma suggestion válida — job não fica em failed só por causa de JSON ruim do modelo')
  })

  await t.test('H. Baixa confiança do worker -> requires_human=true mesmo com intent reconhecido', async () => {
    const conta = await criarContaDeTeste(supabase)
    const job = await enfileirarJob({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'talvez pague, não sei' })
    await proximoJobDisponivel()

    const registro = await aplicarResultadoDoWorker(job, {
      rawClassifyResponse: JSON.stringify({ intent: 'PEDIDO_NOVA_DATA', confidence: 'baixa', cliente_irritado: false }),
      rawGenerateResponse: JSON.stringify({ suggested_reply: 'Ok.', extracted_date: null }),
    })

    assert.equal(registro.requires_human, true)
  })

  await t.test('I. Nenhuma escrita em collection_dispatches/cobrancas_whatsapp/collection_promises pelo fluxo do worker', async () => {
    const conta = await criarContaDeTeste(supabase)
    const job = await enfileirarJob({ contasFinanceirasId: conta.id, clienteTelefone: conta.telefone_cobranca, mensagemCliente: 'quero pagar' })
    await proximoJobDisponivel()
    await aplicarResultadoDoWorker(job, {
      rawClassifyResponse: JSON.stringify({ intent: 'QUERO_PAGAR', confidence: 'alta', cliente_irritado: false }),
      rawGenerateResponse: JSON.stringify({ suggested_reply: 'Ok.', extracted_date: null }),
    })

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('contas_financeiras_id', conta.id)
    const { data: cobrancasLegado } = await supabase.from('cobrancas_whatsapp').select('id').eq('contas_financeiras_id', conta.id)
    const { data: promessasReais } = await supabase.from('collection_promises').select('id').eq('contas_financeiras_id', conta.id)
    assert.equal(dispatches.length, 0)
    assert.equal(cobrancasLegado.length, 0)
    assert.equal(promessasReais.length, 0)
  })

  await pararAmbienteDeTeste()
})

test('IA worker: prova estática — sem Evolution, sem SQL arbitrário, sem segredo exposto ao worker', async () => {
  const arquivos = ['routes/ai-worker.js', 'lib/collection/ai/jobQueue.js', 'lib/collection/ai/workerResult.js', 'middleware/aiWorkerAuth.js', 'lib/collection/ai/replySuggestion.js']
  for (const rel of arquivos) {
    const conteudo = fs.readFileSync(path.join(SRC, rel), 'utf8')
    for (const proibido of ['evolutionAdapter', 'evolutionFinanceiro', 'sendText', '.rpc(', 'execute_sql', 'SUPABASE_SERVICE', 'DATABASE_URL']) {
      assert.equal(conteudo.includes(proibido), false, `${rel} não deveria referenciar "${proibido}"`)
    }
  }

  // A rota /jobs/next só deve devolver os 4 campos autorizados pro worker —
  // nunca a linha inteira de ai_jobs (que tem contas_financeiras_id, status
  // interno etc).
  const rota = fs.readFileSync(path.join(SRC, 'routes/ai-worker.js'), 'utf8')
  assert.ok(/id:\s*job\.id/.test(rota) && /mensagem_cliente:\s*job\.mensagem_cliente/.test(rota), 'GET /jobs/next deveria montar a resposta campo a campo, nunca `res.json(job)` cru')
  assert.equal(/res\.json\(job\)/.test(rota), false, 'nunca devolver o job inteiro cru pro worker')
})

const scriptWorker = fs.readFileSync(path.join(SRC, '..', 'scripts', 'ai-worker.mjs'), 'utf8')
test('IA worker script: nunca loga o corpo da mensagem do cliente', () => {
  assert.equal(/console\.log\([^)]*mensagem_cliente\)/.test(scriptWorker), false)
  assert.ok(scriptWorker.includes('mensagem_cliente.length'), 'deveria logar só o tamanho, nunca o conteúdo')
})
