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

  // FASE C.3D (homologação, 2026-08-12) — segunda tentativa (failover)
  // controlado do INTERNAL_TEST, armado SOMENTE por
  // COLLECTION_INTERNAL_TEST_FAILOVER_KEY + testKey exata. Nunca no
  // INTERNAL_TEST comum, nunca via multi_whatsapp/whatsapp_failover globais.
  async function limparGateFailover() {
    delete process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY
  }

  await t.test('C3D-A. COLLECTION_TEST_MODE=false → nem chega a tentar (guarda existente, sem retry)', async () => {
    await limparGateFailover()
    delete process.env.COLLECTION_TEST_MODE
    await assert.rejects(() => enviarTesteInterno({ testKey: `c3d-a-${Date.now()}`, telefone: '5551900000010', mensagem: 'x' }))
  })

  await t.test('C3D-B. Test mode true, mas COLLECTION_INTERNAL_TEST_FAILOVER_KEY ausente → falha técnica NÃO gera 2ª tentativa', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-c3d-b-principal', 1, 'principal')
    await criarInstancia(supabase, 'wa-c3d-b-reserva', 2, 'reserva')
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-b-principal', { comportamento: 'unavailable' }) // 5xx → TECHNICAL_RETRYABLE
    fakeEvolution.controlarInstancia('wa-c3d-b-reserva', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000011'
    await limparGateFailover() // chave ausente de propósito

    const resultado = await enviarTesteInterno({ testKey: `c3d-b-${Date.now()}`, telefone: '5551900000011', mensagem: 'x' })
    assert.equal(resultado.status, 'failed')
    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('*').eq('dispatch_id', resultado.dispatchId)
    assert.equal(tentativas.length, 1, 'sem a chave de homologação, nunca deveria tentar uma 2ª instância')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0, 'reserva nunca deveria ter recebido chamada real')
  })

  await t.test('C3D-C. Chave de homologação configurada, mas testKey DIFERENTE → sem retry', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-c3d-c-principal', 1, 'principal')
    await criarInstancia(supabase, 'wa-c3d-c-reserva', 2, 'reserva')
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-c-principal', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa-c3d-c-reserva', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000012'
    process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY = 'CHAVE_ARMADA_XYZ'

    const resultado = await enviarTesteInterno({ testKey: `testKey-diferente-${Date.now()}`, telefone: '5551900000012', mensagem: 'x' })
    assert.equal(resultado.status, 'failed')
    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('*').eq('dispatch_id', resultado.dispatchId)
    assert.equal(tentativas.length, 1, 'testKey não bate com a chave armada — comparação exata, nunca prefix/includes')
    await limparGateFailover()
  })

  await t.test('C3D-D. testKey correta + falha TECHNICAL_RETRYABLE → principal falha, reserva assume, exatamente 2 attempts, 1 dispatch', async () => {
    await limparInstanciasDeTeste(supabase)
    const principal = await criarInstancia(supabase, 'wa-c3d-d-principal', 1, 'principal')
    await criarInstancia(supabase, 'wa-c3d-d-reserva', 2, 'reserva')
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-d-principal', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa-c3d-d-reserva', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000013'
    const chave = `c3d-d-${Date.now()}`
    process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY = chave

    const resultado = await enviarTesteInterno({ testKey: chave, telefone: '5551900000013', mensagem: 'x' })
    assert.equal(resultado.status, 'sent')
    assert.equal(resultado.tentativas, 2)
    assert.equal(resultado.instancia, 'wa-c3d-d-reserva')
    assert.equal(resultado.homologacaoFailover, true)

    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('idempotency_key', `internal_test:${chave}`)
    assert.equal(dispatches.length, 1, '1 único logical dispatch mesmo com 2 tentativas')
    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('attempt_number, status').eq('dispatch_id', resultado.dispatchId).order('attempt_number')
    assert.equal(tentativas.length, 2)
    assert.equal(tentativas[0].status, 'failed')
    assert.equal(tentativas[1].status, 'sent')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 1, 'só a reserva deveria ter recebido chamada HTTP real')
    assert.equal(fakeEvolution.mensagensEnviadas[0].instancia, 'wa-c3d-d-reserva')

    // J) falha sintética do principal não pode contaminar o circuit breaker real dele.
    const { data: principalDepois } = await supabase.from('whatsapp_instances').select('consecutive_failures, cooldown_until, health_status').eq('id', principal.id).single()
    assert.equal(principalDepois.consecutive_failures, 0, 'falha sintética da homologação não pode incrementar consecutive_failures real do principal')
    assert.equal(principalDepois.cooldown_until, null, 'falha sintética não pode abrir cooldown real do principal')

    await limparGateFailover()
  })

  await t.test('C3D-E. testKey correta + 429 (rate limit) → NUNCA gera 2ª tentativa (failoverEligible=false)', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-c3d-e-principal', 1, 'principal')
    await criarInstancia(supabase, 'wa-c3d-e-reserva', 2, 'reserva')
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-e-principal', { comportamento: 'rate_limited' })
    fakeEvolution.controlarInstancia('wa-c3d-e-reserva', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000014'
    const chave = `c3d-e-${Date.now()}`
    process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY = chave

    const resultado = await enviarTesteInterno({ testKey: chave, telefone: '5551900000014', mensagem: 'x' })
    assert.equal(resultado.status, 'failed')
    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('*').eq('dispatch_id', resultado.dispatchId)
    assert.equal(tentativas.length, 1)
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
    await limparGateFailover()
  })

  await t.test('C3D-F. testKey correta + 401/403 → NUNCA gera 2ª tentativa', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-c3d-f-principal', 1, 'principal')
    await criarInstancia(supabase, 'wa-c3d-f-reserva', 2, 'reserva')
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-f-principal', { comportamento: 'unauthorized' })
    fakeEvolution.controlarInstancia('wa-c3d-f-reserva', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000015'
    const chave = `c3d-f-${Date.now()}`
    process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY = chave

    const resultado = await enviarTesteInterno({ testKey: chave, telefone: '5551900000015', mensagem: 'x' })
    assert.equal(resultado.status, 'failed')
    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('*').eq('dispatch_id', resultado.dispatchId)
    assert.equal(tentativas.length, 1)
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
    await limparGateFailover()
  })

  await t.test('C3D-G. testKey correta + PLATFORM_RESTRICTION → NUNCA gera 2ª tentativa', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-c3d-g-principal', 1, 'principal')
    await criarInstancia(supabase, 'wa-c3d-g-reserva', 2, 'reserva')
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-g-principal', { comportamento: 'disconnected' }) // 400 → PLATFORM_RESTRICTION
    fakeEvolution.controlarInstancia('wa-c3d-g-reserva', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000016'
    const chave = `c3d-g-${Date.now()}`
    process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY = chave

    const resultado = await enviarTesteInterno({ testKey: chave, telefone: '5551900000016', mensagem: 'x' })
    assert.equal(resultado.status, 'failed')
    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('*').eq('dispatch_id', resultado.dispatchId)
    assert.equal(tentativas.length, 1)
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
    await limparGateFailover()
  })

  await t.test('C3D-H. Gate armado + falha técnica, mas SEM reserva elegível → finaliza failed com 1 attempt, nunca usa comercial', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-c3d-h-principal', 1, 'principal') // única instância cadastrada — sem reserva
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-h-principal', { comportamento: 'unavailable' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000017'
    const chave = `c3d-h-${Date.now()}`
    process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY = chave

    const resultado = await enviarTesteInterno({ testKey: chave, telefone: '5551900000017', mensagem: 'x' })
    assert.equal(resultado.status, 'failed')
    const { data: tentativas } = await supabase.from('collection_dispatch_attempts').select('*').eq('dispatch_id', resultado.dispatchId)
    assert.equal(tentativas.length, 1, 'sem próxima instância elegível, não deveria criar 2ª tentativa')
    assert.equal(fakeEvolution.mensagensEnviadas.length, 0)
    await limparGateFailover()
  })

  await t.test('C3D-I. Mesma testKey armada, chamadas concorrentes → continua só 1 logical dispatch', async () => {
    await limparInstanciasDeTeste(supabase)
    await criarInstancia(supabase, 'wa-c3d-i-principal', 1, 'principal')
    await criarInstancia(supabase, 'wa-c3d-i-reserva', 2, 'reserva')
    fakeEvolution.resetar()
    fakeEvolution.controlarInstancia('wa-c3d-i-principal', { comportamento: 'unavailable' })
    fakeEvolution.controlarInstancia('wa-c3d-i-reserva', { comportamento: 'ok' })
    process.env.COLLECTION_TEST_MODE = 'true'
    process.env.COLLECTION_TEST_PHONE_ALLOWLIST = '5551900000018'
    const chave = `c3d-i-${Date.now()}`
    process.env.COLLECTION_INTERNAL_TEST_FAILOVER_KEY = chave

    const [r1, r2] = await Promise.all([
      enviarTesteInterno({ testKey: chave, telefone: '5551900000018', mensagem: 'x' }),
      enviarTesteInterno({ testKey: chave, telefone: '5551900000018', mensagem: 'x' }),
    ])
    const { data: dispatches } = await supabase.from('collection_dispatches').select('id').eq('idempotency_key', `internal_test:${chave}`)
    assert.equal(dispatches.length, 1, 'idempotência preservada mesmo no caminho com failover')
    assert.equal(r1.dispatchId, r2.dispatchId)
    await limparGateFailover()
  })

  await pararAmbienteDeTeste()
})
