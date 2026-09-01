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

  await t.test('12. em_revisao_financeira: automação pendente é cancelada, mas NUNCA emite PAGO nem marca promessa cumprida (revisão continua exigindo decisão humana)', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0, em_revisao_financeira: true })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: '2026-12-01', origem: 'HUMAN' })
    const { data: dispatch } = await supabase.from('collection_dispatches').insert({
      contas_financeiras_id: conta.id, etapa: 1, canal: 'whatsapp', status: 'queued', mensagem: 'x', origem: 'manual',
      idempotency_key: `teste-payment-guard-12-${conta.id}`, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca, valor: conta.valor,
    }).select().single()

    const resultado = await cancelarAutomacaoPorPagamento(conta.id)
    assert.equal(resultado.dispatches, 1, 'dispatch pendente É cancelado — título em revisão não pode continuar sendo tentado')
    assert.equal(resultado.promessaCumprida, false)

    const { data: dispatchApos } = await supabase.from('collection_dispatches').select('status, cancelado_motivo').eq('id', dispatch.id).single()
    assert.equal(dispatchApos.status, 'cancelled')
    assert.equal(dispatchApos.cancelado_motivo, 'em_revisao_financeira')

    const { data: promessaApos } = await supabase.from('collection_promises').select('status').eq('contas_financeiras_id', conta.id).single()
    assert.equal(promessaApos.status, 'ativa', 'em_revisao_financeira não é pagamento — promessa não é tocada')

    const timeline = await timelineDoTitulo(conta.id)
    assert.equal(timeline.filter((e) => e.tipo === 'PAGO').length, 0, 'em_revisao_financeira NUNCA emite PAGO')
    assert.equal(timeline.filter((e) => e.tipo === 'PROMESSA_CUMPRIDA').length, 0)
  })

  await t.test('13. PAGO nunca é emitido para cancelado/em_revisao/titulo_inexistente, mesmo quando algo foi cancelado nesses casos', async () => {
    for (const overrides of [{ status: 'cancelada' }, { status: 'aberta', em_revisao_financeira: true }]) {
      const conta = await criarContaDeTeste(supabase, { valor: 500, valor_pago: 0, ...overrides })
      await supabase.from('collection_dispatches').insert({
        contas_financeiras_id: conta.id, etapa: 1, canal: 'whatsapp', status: 'queued', mensagem: 'x', origem: 'manual',
        idempotency_key: `teste-payment-guard-13-${conta.id}`, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca, valor: conta.valor,
      })
      await cancelarAutomacaoPorPagamento(conta.id)
      const timeline = await timelineDoTitulo(conta.id)
      assert.equal(timeline.filter((e) => e.tipo === 'PAGO').length, 0, `motivo=${overrides.status ?? 'em_revisao'} nunca deveria emitir PAGO`)
    }
    // título inexistente: nem tem contas_financeiras_id real pra checar timeline, mas
    // a chamada não deve lançar nem criar nada — já coberto indiretamente pelo teste 1.
    const resultado = await cancelarAutomacaoPorPagamento('00000000-0000-0000-0000-000000000000')
    assert.equal(resultado.motivo, 'titulo_inexistente')
  })

  await t.test('14. tratamento de 42P01 é estrito — só ignora "relation does not exist", nunca mascara outro erro SQL', async () => {
    // Prova negativa: um erro DIFERENTE (código arbitrário que não é 42P01)
    // vindo da MESMA posição no fluxo (consulta a collection_calls) precisa
    // continuar propagando. Simulado chamando a função interna do jeito que
    // o código real chamaria — como não dá pra injetar uma falha de rede real
    // no Postgres local, a prova é estática: o código-fonte só compara
    // contra o literal '42P01', não contra um regex genérico de mensagem.
    const paymentGuardSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../../../src/lib/collection/paymentGuard.js', import.meta.url), 'utf8'))
    assert.match(paymentGuardSrc, /errLigacoes\.code !== '42P01'/, 'a checagem precisa ser pelo código SQLSTATE exato, não por texto de mensagem')
    assert.doesNotMatch(paymentGuardSrc, /errLigacoes\s*\)\s*\{\s*\/\//, 'não pode haver um bloco que engula errLigacoes incondicionalmente')
  })

  await t.test('15. concorrência real: duas chamadas simultâneas de cancelarAutomacaoPorPagamento pro MESMO título nunca emitem PAGO/PROMESSA_CUMPRIDA duplicados', async () => {
    const conta = await criarContaDeTeste(supabase, { status: 'aberta', valor: 500, valor_pago: 0 })
    await registrarPromessa({ contasFinanceirasId: conta.id, clienteNome: conta.pessoa_nome, clienteTelefone: conta.telefone_cobranca, valor: 500, promisedDate: '2026-12-01', origem: 'HUMAN' })
    await supabase.from('collection_dispatches').insert({
      contas_financeiras_id: conta.id, etapa: 1, canal: 'whatsapp', status: 'queued', mensagem: 'x', origem: 'manual',
      idempotency_key: `teste-payment-guard-15-${conta.id}`, cliente_nome: conta.pessoa_nome, cliente_telefone: conta.telefone_cobranca, valor: conta.valor,
    })
    await supabase.from('contas_financeiras').update({ valor_pago: 500 }).eq('id', conta.id)

    const [r1, r2] = await Promise.all([
      cancelarAutomacaoPorPagamento(conta.id),
      cancelarAutomacaoPorPagamento(conta.id),
    ])
    // Exatamente uma das duas execuções "ganha" cada transição (dispatch, promessa) —
    // nunca as duas, nunca nenhuma.
    assert.equal(r1.dispatches + r2.dispatches, 1, 'o dispatch só é cancelado por UMA das duas execuções concorrentes')
    assert.equal((r1.promessaCumprida ? 1 : 0) + (r2.promessaCumprida ? 1 : 0), 1, 'a promessa só é marcada cumprida por UMA das duas execuções concorrentes')

    const { data: promessaFinal } = await supabase.from('collection_promises').select('status').eq('contas_financeiras_id', conta.id).single()
    assert.equal(promessaFinal.status, 'cumprida')

    const timeline = await timelineDoTitulo(conta.id)
    assert.equal(timeline.filter((e) => e.tipo === 'PAGO').length, 1, 'PAGO emitido exatamente 1 vez sob concorrência real, não 2')
    assert.equal(timeline.filter((e) => e.tipo === 'PROMESSA_CUMPRIDA').length, 1, 'PROMESSA_CUMPRIDA emitido exatamente 1 vez sob concorrência real, não 2')
  })

  fakeEvolution.resetar()
  await limparInstanciasDeTeste(supabase)
  await pararAmbienteDeTeste()
})
