// FASE C.3A.1 (homologação, 2026-08-12) — dispatch TÉCNICO de homologação
// (INTERNAL_TEST) sem título financeiro real, one-shot, isolado da régua.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(__dirname, '..', '..', '..', 'src')

async function criarInstancia(supabase, nome, prioridade, papel = 'principal') {
  const { data, error } = await supabase.from('whatsapp_instances').insert({
    name: nome, instance_name: nome, priority: prioridade, role: papel, enabled: true,
  }).select().single()
  if (error) throw error
  return data
}

test('INTERNAL_TEST: dispatch técnico sem título financeiro, one-shot, isolado da régua', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { enviarTesteInterno, enviarComFailover } = await import('../../../src/lib/collection/dispatchEngine.js')

  await t.test('1. Cobrança real (purpose padrão) sem contas_financeiras_id é rejeitada pelo banco', async () => {
    const { error } = await supabase.from('collection_dispatches').insert({
      etapa: 1, canal: 'whatsapp', idempotency_key: `teste-${Date.now()}-1`, origem: 'manual',
      mensagem: 'x', cliente_nome: 'X', cliente_telefone: '5551900000001', contas_financeiras_id: null,
    })
    assert.ok(error)
    assert.equal(error.code, '23514', 'violação de CHECK constraint')
  })

  await t.test('2. INTERNAL_TEST sem contas_financeiras_id é permitido', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-it-permitido', 1)
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-it-permitido', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000001'

    const resultado = await enviarTesteInterno({ testKey: `teste-permitido-${Date.now()}`, telefone: '5551900000001', mensagem: 'Teste técnico' })
    assert.equal(resultado.status, 'sent')
    const { data: dispatch } = await supabase.from('collection_dispatches').select('purpose, contas_financeiras_id').eq('id', resultado.dispatchId).single()
    assert.equal(dispatch.purpose, 'internal_test')
    assert.equal(dispatch.contas_financeiras_id, null)

    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('3. INTERNAL_TEST fora da allowlist é bloqueado ANTES de qualquer escrita relevante', async () => {
    fakeEvolution.resetar()
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000099'

    await assert.rejects(() => enviarTesteInterno({ testKey: `teste-fora-${Date.now()}`, telefone: '5551987654321', mensagem: 'x' }))
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)

    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('4. INTERNAL_TEST com allowlist VAZIA é bloqueado', async () => {
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = ''
    await assert.rejects(() => enviarTesteInterno({ testKey: `teste-vazio-${Date.now()}`, telefone: '5551900000001', mensagem: 'x' }))
    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('5. INTERNAL_TEST com allowlist AUSENTE é bloqueado', async () => {
    process.env.COLLECTION_TEST_MODE = 'true'
    delete process.env.COLLECTION_TEST_PHONE_ALLOWLIST
    await assert.rejects(() => enviarTesteInterno({ testKey: `teste-ausente-${Date.now()}`, telefone: '5551900000001', mensagem: 'x' }))
    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('6. Mesmo telefone em formato equivalente é permitido', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-it-formato', 1)
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-it-formato', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '(51) 90000-0002'

    const resultado = await enviarTesteInterno({ testKey: `teste-formato-${Date.now()}`, telefone: '5551900000002', mensagem: 'x' })
    assert.equal(resultado.status, 'sent')

    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('7. DDD diferente é bloqueado (mesmo terminando nos mesmos dígitos)', async () => {
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '900000003' // sem DDD, cadastro incompleto
    await assert.rejects(() => enviarTesteInterno({ testKey: `teste-ddd-${Date.now()}`, telefone: '5511900000003', mensagem: 'x' }))
    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('8. Telefone parcial (allowlist é só um prefixo) é bloqueado', async () => {
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900'
    await assert.rejects(() => enviarTesteInterno({ testKey: `teste-parcial-${Date.now()}`, telefone: '5551900000004', mensagem: 'x' }))
    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('9. Mesma test_key duas vezes → 1 único logical dispatch (idempotência)', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-it-idempotente', 1)
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-it-idempotente', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000005'

    const testKey = `teste-idempotente-${Date.now()}`
    const r1 = await enviarTesteInterno({ testKey, telefone: '5551900000005', mensagem: 'x' })
    const r2 = await enviarTesteInterno({ testKey, telefone: '5551900000005', mensagem: 'x' })

    assert.equal(r1.status, 'sent')
    assert.equal(r2.motivo, 'idempotencia_existente')
    assert.equal(r1.dispatchId, r2.dispatchId)
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só 1 envio real deveria ter acontecido')

    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('10. Execução repetida do harness (mesma test_key, chamadas concorrentes) → segundo envio recusado', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-it-concorrente', 1)
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-it-concorrente', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000006'

    const testKey = `teste-concorrente-${Date.now()}`
    const [r1, r2] = await Promise.all([
      enviarTesteInterno({ testKey, telefone: '5551900000006', mensagem: 'x' }),
      enviarTesteInterno({ testKey, telefone: '5551900000006', mensagem: 'x' }),
    ])
    const statusFinais = [r1.status, r2.status].sort()
    assert.ok(statusFinais.includes('sent'))
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'idempotência: só 1 envio real, mesmo com 2 chamadas concorrentes')

    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('11. INTERNAL_TEST não pode ser criado pelo cron/régua/NBA — prova estática', () => {
    for (const arquivo of ['jobs/cobranca-whatsapp.js', 'jobs/collection-engine.js', 'lib/collection/nextBestAction.js', 'routes/cobrancas.js']) {
      const caminho = path.join(SRC, arquivo)
      if (!fs.existsSync(caminho)) continue
      const conteudo = fs.readFileSync(caminho, 'utf8')
      assert.equal(conteudo.includes('enviarTesteInterno'), false, `${arquivo} não deveria referenciar enviarTesteInterno — INTERNAL_TEST só existe via harness administrativo explícito`)
    }
  })

  await t.test('12. INTERNAL_TEST nunca altera contas_financeiras', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-it-financeiro', 1)
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-it-financeiro', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000007'

    const { count: antes } = await supabase.from('contas_financeiras').select('id', { count: 'exact', head: true })
    await enviarTesteInterno({ testKey: `teste-financeiro-${Date.now()}`, telefone: '5551900000007', mensagem: 'x' })
    const { count: depois } = await supabase.from('contas_financeiras').select('id', { count: 'exact', head: true })
    assert.equal(depois, antes, 'nenhum título deveria ter sido criado/alterado')

    process.env.COLLECTION_TEST_MODE = 'false'
  })

  await t.test('Cobrança real continua funcionando normalmente (zero regressão) — enviarComFailover com título real', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-collection-normal', 1)
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-collection-normal', { comportamento: 'ok' })
    const conta = await criarContaDeTeste(supabase)

    const resultado = await enviarComFailover({
      contasFinanceirasId: conta.id, etapa: 3, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca,
      valor: conta.valor, mensagem: 'Cobrança real', origem: 'manual',
    })
    assert.equal(resultado.status, 'sent')
    const { data: dispatch } = await supabase.from('collection_dispatches').select('purpose').eq('id', resultado.dispatchId).single()
    assert.equal(dispatch.purpose, 'collection', 'default correto sem precisar passar purpose explicitamente')
  })

  await pararAmbienteDeTeste()
})
