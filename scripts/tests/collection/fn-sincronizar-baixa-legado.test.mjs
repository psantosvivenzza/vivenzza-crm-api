// Cobertura local de fn_sincronizar_baixa_legado (versionada em
// supabase/migrations/20260101000047_contas_financeiras_colunas_revisao_conflito.sql
// + 20260101000048_fn_sincronizar_baixa_legado.sql — corpo capturado fielmente
// de produção via pg_get_functiondef/pg_proc, 2026-09-11, leitura read-only,
// nada alterado em produção nessa consulta). A função nunca tinha migration
// nem teste dedicado (ver docs/claude-context/tarefas-pendentes.md, seção
// "Financeiro — RPC não versionada"), apesar de ser o coração da sincronização
// NetVision → CRM (src/jobs/sync-financeiro-legado.js).
//
// Roda 100% contra Postgres LOCAL (LOCAL_PG_URL, banco vivenzza_dev) via RPC
// real (supabase.rpc — mesma chamada que o job de produção faz), nunca contra
// Supabase/produção. Nenhum dos 15 ajustes reais pendentes em
// PREVIEW_RESOLUCAO_125_CONFLITOS.md é aplicado aqui — só contas sintéticas
// (legacy_id 'cr-997%'), criadas e destruídas neste arquivo.
//
// Prova as garantias documentadas no cabeçalho de sync-financeiro-legado.js:
// idempotência, nunca reverter pagamento, nunca duplicar dinheiro — mais
// cancelamento, resolução automática de revisão e encerramento com saldo.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { PG_USER, PG_PASSWORD, PG_PORT, PG_DATABASE } from '../../localdb-config.mjs'
process.env.NODE_ENV = 'test'
process.env.LOCAL_PG_URL = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/${PG_DATABASE}`

const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
const { criarContaDeTeste, telefoneDeTeste } = await import('./_setup.mjs')

const contasCriadas = []
let sufixo = 0

async function criarConta997(overrides = {}) {
  const conta = await criarContaDeTeste(supabase, {
    codigo_cliente: null,
    telefone_cobranca: telefoneDeTeste(),
    ...overrides,
  })
  sufixo += 1
  const { error } = await supabase.from('contas_financeiras')
    .update({ legacy_id: `cr-997${String(sufixo).padStart(3, '0')}-1` })
    .eq('id', conta.id)
  if (error) throw error
  contasCriadas.push(conta.id)
  return conta
}

function sincronizar(params) {
  return supabase.rpc('fn_sincronizar_baixa_legado', {
    p_referencia: 'teste fn-sincronizar-baixa-legado',
    p_cancelado_no_legado: false,
    p_encerrado_no_legado: false,
    ...params,
  })
}

async function baixasAtivasDaConta(contaId) {
  const { data, error } = await supabase.from('baixas_financeiras')
    .select('valor_baixado, origem, status')
    .eq('conta_financeira_id', contaId)
    .eq('status', 'ativa')
  if (error) throw error
  return data
}

// Limpa dependências de FK (baixas_financeiras não tem ON DELETE CASCADE pra
// contas_financeiras) ANTES de apagar as contas — mesmo achado real de
// 47006b8 (limpar deps de FK antes de apagar contas cr-999%), aqui escopado
// só aos ids desta bateria (nunca um LIKE amplo).
after(async () => {
  if (!contasCriadas.length) return
  await supabase.from('baixas_financeiras').delete().in('conta_financeira_id', contasCriadas)
  await supabase.from('contas_financeiras').delete().in('id', contasCriadas)
})

test('fn_sincronizar_baixa_legado', async (t) => {
  await t.test('1. cria baixa espelhada e quita o título quando não há nenhuma baixa anterior', async () => {
    const conta = await criarConta997({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const { data, error } = await sincronizar({
      p_conta_id: conta.id, p_valor_pago_legado: 500, p_data_pagamento: '2026-09-01',
    })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.acao, 'criada')
    assert.equal(data.status, 'paga')
    assert.equal(Number(data.valor_pago), 500)
    assert.equal(data.conflito, false)

    const baixas = await baixasAtivasDaConta(conta.id)
    assert.equal(baixas.length, 1, 'precisa existir exatamente 1 baixa ativa')
    assert.equal(baixas[0].origem, 'sync_legado')
    assert.equal(Number(baixas[0].valor_baixado), 500)
  })

  await t.test('2. idempotente: rodar de novo com o mesmo valor não cria segunda baixa nem muda o total pago', async () => {
    const conta = await criarConta997({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 500, p_data_pagamento: '2026-09-01' })

    const { data, error } = await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 500, p_data_pagamento: '2026-09-01' })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.acao, 'nenhuma', 'valor igual ao já sincronizado não pode gerar nova ação')
    assert.equal(data.conflito, false)
    assert.equal(Number(data.valor_pago), 500)

    const baixas = await baixasAtivasDaConta(conta.id)
    assert.equal(baixas.length, 1, 'rodar 2x não pode duplicar a baixa espelhada')
    assert.equal(Number(baixas[0].valor_baixado), 500)
  })

  await t.test('3. nunca reverte pagamento: legado reportando valor MENOR vira conflito, baixa espelhada não diminui', async () => {
    const conta = await criarConta997({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 500, p_data_pagamento: '2026-09-01' })

    const { data, error } = await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 300, p_data_pagamento: '2026-09-02' })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.conflito, true, 'valor do legado caindo de 500 pra 300 precisa virar conflito, não estorno automático')
    assert.equal(Number(data.valor_pago), 500, 'valor_pago real não pode retroceder')

    const baixas = await baixasAtivasDaConta(conta.id)
    assert.equal(baixas.length, 1)
    assert.equal(Number(baixas[0].valor_baixado), 500, 'a baixa espelhada não pode ser reduzida — só sinaliza conflito')
  })

  await t.test('4. nunca duplica dinheiro: baixa manual existente é descontada do que o sync espelha', async () => {
    const conta = await criarConta997({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const { error: erroManual } = await supabase.from('baixas_financeiras').insert({
      conta_financeira_id: conta.id, valor_baixado: 200, data_pagamento: '2026-08-15',
      forma_pagamento: 'pix', origem: 'manual', status: 'ativa',
    })
    assert.equal(erroManual, null, JSON.stringify(erroManual))

    // Legado diz que 500 já foi pago no total — 200 já está refletido pela
    // baixa manual, então o sync só deve cobrir os 300 restantes.
    const { data, error } = await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 500, p_data_pagamento: '2026-09-01' })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.acao, 'criada')
    assert.equal(Number(data.valor_pago), 500, 'total pago precisa ser 500 (200 manual + 300 sync), nunca 700')
    assert.equal(data.status, 'paga')

    const baixas = await baixasAtivasDaConta(conta.id)
    assert.equal(baixas.length, 2)
    const sync = baixas.find((b) => b.origem === 'sync_legado')
    assert.equal(Number(sync.valor_baixado), 300, 'baixa espelhada só cobre o que a manual ainda não cobria')
  })

  await t.test('5. cancelamento no legado marca a conta como cancelada e é idempotente', async () => {
    const conta = await criarConta997({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })

    const r1 = await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 0, p_data_pagamento: null, p_cancelado_no_legado: true })
    assert.equal(r1.error, null, JSON.stringify(r1.error))
    assert.equal(r1.data.acao, 'cancelado')
    assert.equal(r1.data.status, 'cancelada')

    const { data: contaDb } = await supabase.from('contas_financeiras').select('status').eq('id', conta.id).single()
    assert.equal(contaDb.status, 'cancelada')

    // 2ª chamada — já está cancelada, não pode "re-cancelar" nem lançar erro.
    const r2 = await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 0, p_data_pagamento: null, p_cancelado_no_legado: true })
    assert.equal(r2.error, null, JSON.stringify(r2.error))
    assert.equal(r2.data.status, 'cancelada')
    assert.equal(r2.data.acao, 'nenhuma', 'cancelar uma conta já cancelada não é uma nova ação')
  })

  await t.test('6. título em revisão financeira é resolvido automaticamente quando o sync confirma quitação', async () => {
    const conta = await criarConta997({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01', em_revisao_financeira: true })
    const { error: erroRevisao } = await supabase.from('contas_financeiras')
      .update({ motivo_revisao: 'aguardando comprovante do cliente', em_revisao_desde: new Date().toISOString() })
      .eq('id', conta.id)
    assert.equal(erroRevisao, null, JSON.stringify(erroRevisao))

    const { data, error } = await sincronizar({ p_conta_id: conta.id, p_valor_pago_legado: 500, p_data_pagamento: '2026-09-01' })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.status, 'paga')
    assert.equal(data.revisao_resolvida, true)

    const { data: contaDb } = await supabase.from('contas_financeiras')
      .select('em_revisao_financeira, motivo_revisao, em_revisao_desde')
      .eq('id', conta.id).single()
    assert.equal(contaDb.em_revisao_financeira, false)
    assert.equal(contaDb.motivo_revisao, null)
    assert.equal(contaDb.em_revisao_desde, null)
  })

  await t.test('7. encerrado no legado com saldo pendente força status paga e registra o saldo não recebido', async () => {
    const conta = await criarConta997({ valor: 500, valor_pago: 0, status: 'aberta', vencimento: '2026-12-01' })
    const { data, error } = await sincronizar({
      p_conta_id: conta.id, p_valor_pago_legado: 0, p_data_pagamento: '2026-09-01', p_encerrado_no_legado: true,
    })
    assert.equal(error, null, JSON.stringify(error))
    assert.equal(data.status, 'paga', 'encerrado no legado precisa parar de ser cobrado mesmo com saldo')
    assert.equal(data.encerrado_com_saldo, true)
    assert.equal(Number(data.saldo), 500, 'saldo real não recebido continua exposto no retorno, só o status muda')

    const { data: contaDb } = await supabase.from('contas_financeiras').select('observacao_pagamento').eq('id', conta.id).single()
    assert.match(contaDb.observacao_pagamento || '', /Encerrado no NetVision/)
  })
})
