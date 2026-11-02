// Wrapper real + advisor real; SDK de IA, banco, relógio/timers e config fictícios.
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import { createLeadStageAdvisor, PIPELINE_STAGE_PROMPT, parseStageAdvice } from '../../src/lib/leadStageAdvisor.js'

async function carregar({ flags, aoClassificar, erroReleitura = false, resultadoRpc = true } = {}) {
  const config = flags ?? { lara_pipeline_automatico: true, alerta_sem_resposta_por_conversa: true }
  const lead = { id: 'lead-ficticio', etapa: 'contato', ativo: true, whatsapp_opt_out: false,
    responsavel_id: 'vendedor-ficticio', updated_at: '2026-10-31T12:00:00Z' }
  const rows = [
    { id: 'row-1', evolution_id: 'in-1', direcao: 'entrada', mensagem: 'Quero os produtos deste catálogo.', created_at: '2026-10-31T12:00:00Z' },
    { id: 'row-2', evolution_id: 'out-2', direcao: 'saida', mensagem: 'A proposta para os itens solicitados está pronta.', created_at: '2026-10-31T12:00:00Z' },
  ]
  const queries = [], models = [], rpcs = [], timers = []
  let leiturasMensagens = 0
  const context = vm.createContext({ AbortSignal, process: { env: { ANTHROPIC_API_KEY: 'chave-ficticia' } }, console: { error() {} } })
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { context })
  const builder = (tabela, rpcValue) => {
    const trace = { tabela, filtros: [], ordens: [], abort: false }
    queries.push(trace)
    const q = {
      select(value) { trace.select = value; return q },
      eq(key, value) { trace.filtros.push([key, value]); return q },
      not(...args) { trace.not = args; return q },
      order(key, options) { trace.ordens.push([key, options.ascending]); return q },
      limit(value) { trace.limit = value; return q },
      maybeSingle() { trace.single = true; return q },
      abortSignal(signal) { trace.abort = signal instanceof AbortSignal; return q },
      then(resolve, reject) {
        if (tabela === 'rpc') return Promise.resolve({ data: rpcValue, error: null }).then(resolve, reject)
        if (tabela === 'leads') return Promise.resolve({ data: structuredClone(lead), error: null }).then(resolve, reject)
        assert.equal(tabela, 'whatsapp_mensagens')
        leiturasMensagens++
        if (erroReleitura && leiturasMensagens > 1) return Promise.resolve({ data: null, error: { message: 'Erro fictício privado' } }).then(resolve, reject)
        const data = structuredClone(rows).sort((a, b) => {
          for (const [key, asc] of trace.ordens) {
            if (a[key] < b[key]) return asc ? -1 : 1
            if (a[key] > b[key]) return asc ? 1 : -1
          }
          return 0
        }).slice(0, trace.limit)
        return Promise.resolve({ data, error: null }).then(resolve, reject)
      },
    }
    return q
  }
  class FakeAnthropic {
    constructor(options) {
      assert.equal(options.maxRetries, 0)
      this.messages = { create: async payload => {
        models.push(payload)
        aoClassificar?.({ config, lead, rows })
        return { content: [{ type: 'text', text: JSON.stringify({ etapa: 'proposta', confidence: 0.96,
          message_id: 'out-2', evidence: 'proposta para os itens solicitados' }) }] }
      } }
    }
  }
  const mod = new vm.SourceTextModule(await readFile(new URL('../../src/lib/commercialConversationObserver.js', import.meta.url), 'utf8'), {
    context,
    importModuleDynamically: async spec => {
      assert.equal(spec, '@anthropic-ai/sdk')
      const sdk = synthetic({ default: FakeAnthropic })
      await sdk.link(() => { throw Error('Import não permitido') })
      await sdk.evaluate()
      return sdk
    },
  })
  await mod.link(spec => {
    if (spec === './leadStageAdvisor.js') return synthetic({ PIPELINE_STAGE_PROMPT, parseStageAdvice,
      createLeadStageAdvisor: deps => createLeadStageAdvisor({ ...deps, now: () => 1000,
        setTimer: callback => { timers.push(callback); return { unref() {} } }, clearTimer() {} }) })
    if (spec === './collection/featureFlags.js') return synthetic({ obterConfigCobranca: async () => config })
    if (spec === './supabase-admin.server.js') return synthetic({ supabase: {
      from: tabela => builder(tabela),
      rpc: (nome, args) => { rpcs.push({ nome, args }); return builder('rpc', resultadoRpc) },
    } })
    throw Error('Import não permitido')
  })
  await mod.evaluate()
  return { run: () => mod.namespace.observeCommercialStage(lead.id), queries, models, rpcs, timers }
}

test('observador real lê ordem estável, relê e aplica somente etapa/evidência/versão esperadas', async () => {
  const h = await carregar()
  assert.equal((await h.run()).status, 'advanced')
  assert.equal(h.models.length, 1)
  assert.deepEqual(JSON.parse(h.models[0].messages[0].content).messages.map(m => m.id), ['in-1', 'out-2'])
  const msgs = h.queries.filter(q => q.tabela === 'whatsapp_mensagens')
  assert.equal(msgs.length, 2)
  for (const q of msgs) {
    assert.deepEqual(q.ordens, [['created_at', false], ['id', false]])
    assert.deepEqual(q.filtros, [['lead_id', 'lead-ficticio']])
    assert.equal(q.limit, 20)
    assert.equal(q.abort, true)
  }
  assert.equal(h.rpcs.length, 1)
  assert.equal(h.rpcs[0].nome, 'apply_lead_stage_advice')
  assert.deepEqual(JSON.parse(JSON.stringify(h.rpcs[0].args)), {
    p_lead_id: 'lead-ficticio', p_expected_stage: 'contato', p_expected_version: '2026-10-31T12:00:00Z',
    p_next_stage: 'proposta', p_message_id: 'out-2', p_evidence: 'proposta para os itens solicitados',
  })
})

test('cada opt-in necessário ausente/desligado impede consultas, modelo e RPC', async () => {
  for (const flags of [{}, { lara_pipeline_automatico: true }, { alerta_sem_resposta_por_conversa: true },
    { lara_pipeline_automatico: true, alerta_sem_resposta_por_conversa: false }]) {
    const h = await carregar({ flags })
    assert.equal((await h.run()).status, 'disabled')
    assert.equal(h.queries.length, 0)
    assert.equal(h.models.length, 0)
    assert.equal(h.rpcs.length, 0)
  }
})

test('desligamento durante modelo no wrapper real impede RPC', async () => {
  const h = await carregar({ aoClassificar: ({ config }) => { config.lara_pipeline_automatico = false } })
  assert.equal((await h.run()).status, 'disabled')
  assert.equal(h.rpcs.length, 0)
})

test('mensagem nova persistida durante modelo invalida a recomendação e mantém análise enfileirada', async () => {
  const h = await carregar({ aoClassificar: ({ rows }) => rows.push({ id: 'row-3', evolution_id: 'in-3',
    direcao: 'entrada', mensagem: 'Preciso mudar o pedido antes de continuar.', created_at: '2026-10-31T12:01:00Z' }) })
  assert.equal((await h.run()).status, 'stale')
  assert.equal(h.rpcs.length, 0)
  assert.ok(h.timers.length > 0)
})

test('erro na releitura do wrapper real bloqueia alteração', async () => {
  const h = await carregar({ erroReleitura: true })
  await assert.rejects(h.run(), /STAGE_EVIDENCE_UNAVAILABLE/)
  assert.equal(h.rpcs.length, 0)
})

test('somente boolean true da RPC confirma avanço, dados malformados não são sucesso', async () => {
  for (const resultadoRpc of [false, 'true', {}]) {
    const h = await carregar({ resultadoRpc })
    assert.equal((await h.run()).status, 'conflict')
    assert.equal(h.rpcs.length, 1)
  }
})
