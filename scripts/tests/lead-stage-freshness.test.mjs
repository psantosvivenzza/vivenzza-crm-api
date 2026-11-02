import test from 'node:test'
import assert from 'node:assert/strict'
import { createLeadStageAdvisor } from '../../src/lib/leadStageAdvisor.js'

const lead = { id: 'lead-ficticio', etapa: 'contato', ativo: true, whatsapp_opt_out: false,
  responsavel_id: 'vendedor-ficticio', updated_at: '2026-10-31T12:00:00Z' }
const messages = [{ id: 'row-1', evolution_id: 'out-1', direcao: 'saida', created_at: '2026-10-31T12:00:00Z',
  mensagem: 'A proposta para os itens solicitados está pronta.' }]
const advice = { etapa: 'proposta', confidence: 0.96, message_id: 'out-1', evidence: 'proposta para os itens solicitados' }
const snapshot = () => structuredClone({ lead, messages })

function preparar({ alterar = () => {}, desativar = false, erroReleitura = false } = {}) {
  const estado = snapshot(), aplicacoes = [], timers = []
  let ativo = true, leituras = 0, modelos = 0, clock = 1000
  const run = createLeadStageAdvisor({
    enabled: async () => ativo,
    load: async () => {
      leituras++
      if (erroReleitura && leituras > 1) throw Error('Releitura fictícia indisponível')
      return structuredClone(estado)
    },
    classify: async () => {
      modelos++
      alterar(estado)
      if (desativar) ativo = false
      return advice
    },
    apply: async args => { aplicacoes.push(args); return true },
    now: () => clock,
    setTimer: callback => { timers.push(callback); return { unref() {} } },
    clearTimer() {},
  })
  return { run, aplicacoes, timers, modelos: () => modelos, leituras: () => leituras, avancar: () => { clock += 60000 } }
}

test('desligamento durante análise impede aplicação e evita releitura desnecessária', async () => {
  const h = preparar({ desativar: true })
  assert.equal((await h.run(lead.id)).status, 'disabled')
  assert.equal(h.aplicacoes.length, 0)
  assert.equal(h.leituras(), 1)
})

test('nova mensagem impede recomendação obsoleta e agenda análise da conversa atual', async () => {
  const h = preparar({ alterar: estado => estado.messages.push({ id: 'row-2', evolution_id: 'in-2', direcao: 'entrada',
    created_at: '2026-10-31T12:01:00Z', mensagem: 'Preciso corrigir os itens antes da proposta.' }) })
  const r = await h.run(lead.id)
  assert.equal(r.status, 'stale')
  assert.equal(r.requeued, true)
  assert.equal(h.aplicacoes.length, 0)
  assert.equal(h.leituras(), 2)
  assert.ok(h.timers.length > 0)
})

test('mudança de etapa, versão ou responsável pelo vendedor preserva a decisão humana', async () => {
  for (const alterar of [
    estado => { estado.lead.etapa = 'negociacao' },
    estado => { estado.lead.updated_at = '2026-10-31T12:01:00Z' },
    estado => { estado.lead.responsavel_id = 'outro-vendedor-ficticio' },
  ]) {
    const h = preparar({ alterar })
    assert.equal((await h.run(lead.id)).status, 'stale')
    assert.equal(h.aplicacoes.length, 0)
  }
})

test('evidência editada ou removida durante classificação não avança etapa', async () => {
  for (const alterar of [estado => { estado.messages[0].mensagem = 'Outra conversa fictícia' }, estado => { estado.messages = [] }]) {
    const h = preparar({ alterar })
    assert.notEqual((await h.run(lead.id)).status, 'advanced')
    assert.equal(h.aplicacoes.length, 0)
  }
})

test('falha de releitura não permite aplicar recomendação', async () => {
  const h = preparar({ erroReleitura: true })
  await assert.rejects(h.run(lead.id), /Releitura fictícia/)
  assert.equal(h.aplicacoes.length, 0)
})

test('conversa estável aplica uma vez com evidência, versão e etapa originais', async () => {
  const h = preparar()
  assert.equal((await h.run(lead.id)).status, 'advanced')
  assert.equal(h.leituras(), 2)
  assert.equal(h.aplicacoes.length, 1)
  assert.deepEqual(h.aplicacoes[0], { leadId: lead.id, expectedStage: lead.etapa,
    expectedVersion: lead.updated_at, etapa: 'proposta', messageId: 'out-1', evidence: advice.evidence })
})

test('reanálise automática por conversa obsoleta tem teto e evento novo inicia nova rodada', async () => {
  const h = preparar({ alterar: estado => estado.messages.push({ evolution_id: `fixture-${estado.messages.length}`,
    direcao: 'entrada', mensagem: 'Nova condição fictícia.' }) })
  assert.equal((await h.run(lead.id)).requeued, true)
  h.avancar()
  h.timers.at(-1)()
  for (let i = 0; i < 40; i++) await Promise.resolve()
  assert.equal(h.modelos(), 2)
  assert.equal(h.timers.length, 1, 'Segunda análise obsoleta não pode realimentar a fila')
  assert.equal(h.aplicacoes.length, 0)
  h.avancar()
  assert.equal((await h.run(lead.id)).requeued, true)
  assert.equal(h.modelos(), 3)
})

test('etapa negociação não consome modelo, pois não existe avanço automático permitido acima dela', async () => {
  let modelos = 0
  const run = createLeadStageAdvisor({ enabled: async () => true,
    load: async () => ({ lead: { ...lead, etapa: 'negociacao' }, messages }),
    classify: async () => { modelos++; return advice }, apply: async () => assert.fail('Sem avanço permitido') })
  assert.equal((await run(lead.id)).status, 'ignored')
  assert.equal(modelos, 0)
})
