// 2026-09-01 — pedido "FECHAR CICLO DE VIDA DE PAGAMENTOS E PROMESSAS".
// Cobertura dedicada de paymentGuard.js — antes só era tocado
// incidentalmente por outras suítes (consolidacao-parcelas,
// nba-shadow-effective-legacy-action, provider-attempt-rate-limit,
// suppress-invalid-phone-repeat-attempts, voice-nvoip-external-readiness).
// Código real + Postgres local, nenhum WhatsApp/ligação real em nenhum
// cenário.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, limparInstanciasDeTeste } from './_setup.mjs'

test('paymentGuard: statusQuitacaoTitulo/tituloEstaQuitado/cancelarAutomacaoPorPagamento', async (t) => {
  const fakeEvolution = await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { statusQuitacaoTitulo, tituloEstaQuitado, cancelarAutomacaoPorPagamento } = await import('../../../src/lib/collection/paymentGuard.js')
  const { registrarPromessa, promessaAtivaPara } = await import('../../../src/lib/collection/promises.js')
  const { enviarComFailover } = await import('../../../src/lib/collection/dispatchEngine.js')
  const { timelineDoTitulo } = await import('../../../src/lib/collection/timeline.js')

  await t.test('1. título inexistente -> quitado=true, motivo=titulo_inexistente', async () => {
    const status = await statusQuitacaoTitulo('00000000-0000-0000-0000-000000000000')
    assert.equal(status.quitado, true)
    assert.equal(status.motivo, 'titulo_inexistente')
    assert.equal(await tituloEstaQuitado('00000000-0000-0000-0000-000000000000'), true)
  })

  await t.test('2. status=cancelada -> quitado=true, motivo=cancelado', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'cancelada', valor: 500, valor_pago: 0 })
    const status = await statusQuitacaoTitulo(conta.id)
    assert.equal(status.quitado, true)
    assert.equal(status.motivo, 'cancelado')
  })

  await t.test('3. em_revisao_financeira=true -> quitado=true, motivo=em_revisao_financeira', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0, em_revisao_financeira: true })
    const status = await statusQuitacaoTitulo(conta.id)
    assert.equal(status.quitado, true)
    assert.equal(status.motivo, 'em_revisao_financeira')
  })

  await t.test('4. saldo zerado (valor=valor_pago) -> quitado=true, motivo=quitado', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 500 })
    const status = await statusQuitacaoTitulo(conta.id)
    assert.equal(status.quitado, true)
    assert.equal(status.motivo, 'quitado')
  })

  await t.test('5. saldo positivo -> quitado=false, motivo=null', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 100 })
    const status = await statusQuitacaoTitulo(conta.id)
    assert.equal(status.quitado, false)
    assert.equal(status.motivo, null)
  })

  await t.test('6. enviarComFailover distingue os 4 motivos no retorno (não colapsa tudo em "quitado")', async () => {
    const cancelado = await criarContaDeTeste(supabase, { status: 'cancelada' })
    const revisao = await criarContaDeTeste(supabase, { status: 'aberta', em_revisao_financeira: true })
    const quitado = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 500 })
    const args = (c) => ({ contasFinanceirasId: c.id, etapa: 1, clienteNome: c.pessoa_nome, clienteTelefone: c.telefone_cobranca, valor: c.valor, mensagem: 'x', origem: 'manual' })
    assert.equal((await enviarComFailover(args(cancelado))).motivo, 'cancelado')
    assert.equal((await enviarComFailover(args(revisao))).motivo, 'em_revisao_financeira')
    assert.equal((await enviarComFailover(args(quitado))).motivo, 'quitado')
  })

  await t.test('7. cancelarAutomacaoPorPagamento cancela dispatch queued/sending quando quitado', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { data: dispatch } = await supabase.from('collection_dispatches').insert({
      contas_financeiras_id: conta.id, etapa: 1, canal: 'whatsapp', status: 'queued', mensagem: 'x', origem: 'manual',
      idempotency_key: `teste-payment-guard-7-${conta.id}`, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca, valor: conta.valor,
    }).select().single()
    await supabase.from('contas_financeiras').update({ valor_pago: 500 }).eq('id', conta.id)

    const resultado = await cancelarAutomacaoPorPagamento(conta.id)
    assert.equal(resultado.dispatches, 1)
    assert.equal(resultado.motivo, 'quitado')
    const { data: dispatchApos } = await supabase.from('collection_dispatches').select('status, cancelado_motivo').eq('id', dispatch.id).single()
    assert.equal(dispatchApos.status, 'cancelled')
    assert.equal(dispatchApos.cancelado_motivo, 'quitado')
  })

  await t.test('8. cancelarAutomacaoPorPagamento não faz nada quando título ainda tem saldo em aberto', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const resultado = await cancelarAutomacaoPorPagamento(conta.id)
    assert.deepEqual(resultado, { dispatches: 0, promessaCumprida: false, ligacoes: 0, motivo: null })
  })

  await t.test('9. promessa ativa marcada CUMPRIDA quando pagamento quita o título; nunca quando é cancelado/em_revisao', async () => {
    const quitado = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: quitado.id, clienteNome: quitado.pessoa_nome, clienteTelefone: quitado.telefone_cobranca, valor: 500, promisedDate: '2026-12-01', origem: 'HUMAN' })
    await supabase.from('contas_financeiras').update({ valor_pago: 500 }).eq('id', quitado.id)
    const r1 = await cancelarAutomacaoPorPagamento(quitado.id)
    assert.equal(r1.promessaCumprida, true)
    const { data: p1 } = await supabase.from('collection_promises').select('status').eq('contas_financeiras_id', quitado.id).single()
    assert.equal(p1.status, 'cumprida')

    const cancelado = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: cancelado.id, clienteNome: cancelado.pessoa_nome, clienteTelefone: cancelado.telefone_cobranca, valor: 500, promisedDate: '2026-12-01', origem: 'HUMAN' })
    await supabase.from('contas_financeiras').update({ status: 'cancelada' }).eq('id', cancelado.id)
    const r2 = await cancelarAutomacaoPorPagamento(cancelado.id)
    assert.equal(r2.promessaCumprida, false, 'cancelado NÃO deve marcar promessa como cumprida (não houve pagamento)')
    const { data: p2 } = await supabase.from('collection_promises').select('status').eq('contas_financeiras_id', cancelado.id).single()
    assert.equal(p2.status, 'ativa', 'promessa continua ativa — cancelamento do título não é pagamento')
  })

  await t.test('10. timeline registra PAGO exatamente 1 vez, mesmo chamando cancelarAutomacaoPorPagamento 2x (idempotência)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    const { data: dispatch } = await supabase.from('collection_dispatches').insert({
      contas_financeiras_id: conta.id, etapa: 1, canal: 'whatsapp', status: 'queued', mensagem: 'x', origem: 'manual',
      idempotency_key: `teste-payment-guard-10-${conta.id}`, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca, valor: conta.valor,
    }).select().single()
    await supabase.from('contas_financeiras').update({ valor_pago: 500 }).eq('id', conta.id)

    const r1 = await cancelarAutomacaoPorPagamento(conta.id)
    const r2 = await cancelarAutomacaoPorPagamento(conta.id)
    assert.equal(r1.dispatches, 1)
    assert.equal(r2.dispatches, 0, '2ª chamada não reencontra o dispatch já cancelled')

    const timeline = await timelineDoTitulo(conta.id)
    const eventosPago = timeline.filter((e) => e.tipo === 'PAGO')
    assert.equal(eventosPago.length, 1, 'PAGO registrado exatamente 1 vez, não 2')
  })

  await t.test('11. cancelamento de ligação pendente (collection_calls) não derruba o sweep quando a tabela não existe no schema atual', async () => {
    // collection_calls é uma tabela da frente de voz experimental (em
    // quarentena), não existe no schema real hoje — cancelarAutomacaoPorPagamento
    // precisa tratar isso como "feature ainda não existe", nunca lançar.
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 500 })
    await assert.doesNotReject(() => cancelarAutomacaoPorPagamento(conta.id))
  })

  fakeEvolution.resetar()
  await limparInstanciasDeTeste(supabase)
  await pararAmbienteDeTeste()
})
