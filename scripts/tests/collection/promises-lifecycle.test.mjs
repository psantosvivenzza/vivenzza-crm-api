// 2026-09-01 — pedido "FECHAR CICLO DE VIDA DE PAGAMENTOS E PROMESSAS".
// Cobertura dedicada de promises.js — antes zero teste para
// processarPromessasVencidas/marcarPromessaQuebrada/marcarPromessaCumprida.
// Código real + Postgres local, nenhum WhatsApp real.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

const AMANHA = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10)
const ONTEM = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10)
const HOJE = new Date().toISOString().slice(0, 10)

test('promises: ciclo de vida completo (ativa/vencida/quebrada/cumprida/substituída)', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const {
    registrarPromessa, promessaAtivaPara, marcarPromessaCumprida, marcarPromessaQuebrada, processarPromessasVencidas,
  } = await import('../../../src/lib/collection/promises.js')
  const { timelineDoTitulo } = await import('../../../src/lib/collection/timeline.js')
  const { enviarComFailover } = await import('../../../src/lib/collection/dispatchEngine.js')

  await t.test('1. promessa futura continua ativa após processarPromessasVencidas', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: AMANHA, origem: 'HUMAN' })
    await processarPromessasVencidas(HOJE)
    const ativa = await promessaAtivaPara(conta.id)
    assert.ok(ativa, 'promessa futura não deve ser afetada')
    assert.equal(ativa.status, 'ativa')
  })

  await t.test('2. promessa vencida vira quebrada via processarPromessasVencidas', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const p = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: ONTEM, origem: 'HUMAN' })
    await processarPromessasVencidas(HOJE)
    const { data: apos } = await supabase.from('collection_promises').select('status, broken_at').eq('id', p.id).single()
    assert.equal(apos.status, 'quebrada')
    assert.ok(apos.broken_at)
  })

  await t.test('3. PROMESSA_QUEBRADA é emitido exatamente 1 vez, mesmo rodando processarPromessasVencidas 2x', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const p = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: ONTEM, origem: 'HUMAN' })
    const r1 = await processarPromessasVencidas(HOJE)
    const r2 = await processarPromessasVencidas(HOJE)
    assert.ok(r1.some((x) => x.id === p.id), '1ª execução deve pegar a promessa recém-criada')
    assert.ok(!r2.some((x) => x.id === p.id), '2ª execução não reencontra a mesma promessa já quebrada')
    const timeline = await timelineDoTitulo(conta.id)
    const eventos = timeline.filter((e) => e.tipo === 'PROMESSA_QUEBRADA')
    assert.equal(eventos.length, 1)
  })

  await t.test('4. promessa quebrada deixa de bloquear a régua — título volta a ser elegível', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: ONTEM, origem: 'HUMAN' })

    const antes = await enviarComFailover({ contasFinanceirasId: conta.id, etapa: 1, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'manual' })
    assert.equal(antes.motivo, 'promessa_ativa')

    await processarPromessasVencidas(HOJE)
    assert.equal(await promessaAtivaPara(conta.id), null)

    const depois = await enviarComFailover({ contasFinanceirasId: conta.id, etapa: 2, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: conta.valor, mensagem: 'x', origem: 'manual' })
    assert.notEqual(depois.motivo, 'promessa_ativa')
  })

  await t.test('5. nova promessa substitui (cancela) a anterior — nunca duas ativas', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const p1 = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: AMANHA, origem: 'HUMAN' })
    const p2 = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: AMANHA, origem: 'HUMAN' })
    const { data: p1Apos } = await supabase.from('collection_promises').select('status').eq('id', p1.id).single()
    assert.equal(p1Apos.status, 'cancelada')
    const ativa = await promessaAtivaPara(conta.id)
    assert.equal(ativa.id, p2.id)
  })

  await t.test('6. marcarPromessaCumprida registra PROMESSA_CUMPRIDA e libera a régua', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const p = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: AMANHA, origem: 'HUMAN' })
    await marcarPromessaCumprida(p.id)
    assert.equal(await promessaAtivaPara(conta.id), null)
    const timeline = await timelineDoTitulo(conta.id)
    assert.equal(timeline.filter((e) => e.tipo === 'PROMESSA_CUMPRIDA').length, 1)
  })

  await t.test('7. marcarPromessaQuebrada (chamada direta) registra PROMESSA_QUEBRADA e libera a régua', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const p = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: AMANHA, origem: 'HUMAN' })
    await marcarPromessaQuebrada(p.id)
    assert.equal(await promessaAtivaPara(conta.id), null)
    const timeline = await timelineDoTitulo(conta.id)
    assert.equal(timeline.filter((e) => e.tipo === 'PROMESSA_QUEBRADA').length, 1)
  })

  await t.test('8. índice único parcial impede duas promessas ativas simultâneas pro mesmo título (nível banco)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: AMANHA, origem: 'HUMAN' })
    // insert direto (bypassando registrarPromessa, que já cancela a anterior) — prova que a garantia é do BANCO, não só da lógica de aplicação
    const { error } = await supabase.from('collection_promises').insert({
      contas_financeiras_id: conta.id, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca,
      valor: 500, promised_date: AMANHA, origem: 'HUMAN', status: 'ativa',
    })
    assert.ok(error, 'segunda promessa ativa direta deve violar o índice único parcial')
    assert.equal(error.code, '23505')
  })

  await t.test('9. idempotência: promessa futura não é afetada por processarPromessasVencidas, mesmo rodando 2x', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const p = await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: AMANHA, origem: 'HUMAN' })
    await processarPromessasVencidas(HOJE)
    await processarPromessasVencidas(HOJE)
    const ativa = await promessaAtivaPara(conta.id)
    assert.ok(ativa)
    assert.equal(ativa.id, p.id)
    assert.equal(ativa.status, 'ativa')
  })

  await pararAmbienteDeTeste()
})
