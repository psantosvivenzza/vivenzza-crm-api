// Correção matemática de recoveryScore/priorityScore — gap identificado no
// mapeamento do backlog "SCORE/RÉGUA" (2026-08-14): já existia teste de
// EQUIVALÊNCIA da otimização de performance (priority-score-otimizacao.test.mjs),
// mas nenhum teste fixava valores esperados componente a componente. Cada caso
// aqui calcula o valor esperado manualmente a partir dos pesos reais
// (PESO em priorityScore.js/recoveryScore.js) para pegar qualquer regressão de
// fórmula/arredondamento, não só de performance.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste, telefoneDeTeste } from './_setup.mjs'

let supabase, calcularRecoveryScore, calcularPriorityScore, percentilEmDistribuicao, hojeBrtISO, diasAtrasoDe

before(async () => {
  await iniciarAmbienteDeTeste()
  ;({ supabase } = await import('../../../src/lib/supabase-admin.server.js'))
  ;({ calcularRecoveryScore } = await import('../../../src/lib/collection/recoveryScore.js'))
  ;({ calcularPriorityScore, percentilEmDistribuicao } = await import('../../../src/lib/collection/priorityScore.js'))
  ;({ hojeBrtISO, diasAtrasoDe } = await import('../../../src/lib/collection/collectionContactPolicy.js'))
})
after(async () => { await pararAmbienteDeTeste() })

// Deriva de hojeBrtISO() (a mesma fonte de "hoje" que diasAtrasoDe() usa) em vez
// de Date.now() puro — perto da virada UTC/BRT (BRT = UTC-3), "hoje" em UTC e
// "hoje" em BRT podem ser dias de calendário diferentes, e isso deslocava
// diasAtraso em ±1 dependendo do horário em que o teste rodava.
function diasAtras(n) {
  const [ano, mes, dia] = hojeBrtISO().split('-').map(Number)
  const d = new Date(Date.UTC(ano, mes - 1, dia) - n * 24 * 60 * 60 * 1000)
  return d.toISOString().slice(0, 10)
}

test('percentilEmDistribuicao: pura, sem I/O — 3 de 5 valores <= alvo -> 0.6', () => {
  assert.equal(percentilEmDistribuicao(300, [100, 200, 300, 400, 500]), 0.6)
})

test('recoveryScore: sem histórico de terceiros (só o próprio título) -> componentes neutros batem o esperado', async () => {
  const pessoaNome = `Teste Recovery ${Date.now()}`
  const conta = await criarContaDeTeste(supabase, {
    pessoa_nome: pessoaNome,
    status: 'vencida', // conta a receber "em aberto" -> historico_pagamentos vê a si mesma, 0/1 pagos
    vencimento: diasAtras(10),
    codigo_cliente: null, // sem vínculo -> relacionamento neutro
  })

  const { score, componentes } = await calcularRecoveryScore(conta.id)

  // diasAtraso calculado a partir do vencimento REALMENTE persistido (não do
  // que foi enviado no insert) — o compat client de Postgres local devolve
  // `date` como objeto Date com deslocamento de fuso (quirk só do driver de
  // dev local; PostgREST real em produção devolve string, sem esse problema),
  // então recalcular aqui evita um teste frágil por causa disso.
  const diasAtrasoReal = diasAtrasoDe(conta.vencimento)
  const dias_atraso_esperado = Math.round(15 * Math.max(0, 1 - diasAtrasoReal / 60))

  // historico_pagamentos: só o próprio título (status='vencida', não 'paga') -> 0/1 -> 0 pts, disponivel:true (há 1 título, não é "sem histórico")
  assert.equal(componentes.historico_pagamentos.valor, 0)
  assert.equal(componentes.historico_pagamentos.disponivel, true)
  // engajamento_cobranca: nenhum envio em cobrancas_whatsapp para essa pessoa -> neutro (50% de 20 = 10)
  assert.equal(componentes.engajamento_cobranca.valor, 10)
  assert.equal(componentes.engajamento_cobranca.disponivel, false)
  // comportamento_promessas: nenhuma promessa -> neutro (50% de 20 = 10)
  assert.equal(componentes.comportamento_promessas.valor, 10)
  assert.equal(componentes.comportamento_promessas.disponivel, false)
  assert.equal(componentes.dias_atraso.valor, dias_atraso_esperado)
  assert.equal(componentes.dias_atraso.disponivel, true)
  // relacionamento: sem codigo_cliente -> neutro (50% de 15 = 8, arredondado)
  assert.equal(componentes.relacionamento.valor, 8)
  assert.equal(componentes.relacionamento.disponivel, false)

  assert.equal(score, 0 + 10 + 10 + dias_atraso_esperado + 8)
})

test('recoveryScore: título não vencido -> componente dias_atraso no máximo', async () => {
  const conta = await criarContaDeTeste(supabase, {
    pessoa_nome: `Teste Recovery Futuro ${Date.now()}`,
    status: 'aberta',
    vencimento: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    codigo_cliente: null,
  })
  const { componentes } = await calcularRecoveryScore(conta.id)
  assert.equal(componentes.dias_atraso.valor, 15) // PESO.dias_atraso = 15, não vencido = máximo
  assert.equal(componentes.dias_atraso.detalhe, 'título ainda não vencido')
})

test('priorityScore: distribuição pré-carregada + promessa quebrada + interação recente -> soma bate o esperado', async () => {
  const conta = await criarContaDeTeste(supabase, {
    pessoa_nome: `Teste Priority ${Date.now()}`,
    valor: 300,
    valor_pago: 0,
    status: 'vencida',
    vencimento: diasAtras(30),
  })

  const { error: eProm } = await supabase.from('collection_promises').insert({
    contas_financeiras_id: conta.id,
    cliente_nome: conta.pessoa_nome,
    cliente_telefone: conta.telefone_cobranca,
    valor: 300,
    promised_date: diasAtras(-1),
    origem: 'HUMAN',
    status: 'quebrada',
  })
  if (eProm) throw eProm

  const { error: eEvento } = await supabase.from('collection_timeline_events').insert({
    contas_financeiras_id: conta.id,
    cliente_telefone: conta.telefone_cobranca,
    tipo: 'RESPONDEU',
    origem: 'AUTOMATION',
    descricao: 'teste',
  })
  if (eEvento) throw eEvento

  const distribuicaoSaldos = [100, 200, 300, 400, 500] // 3 de 5 <= 300 -> percentil 0.6
  const { score, componentes } = await calcularPriorityScore(conta.id, { recoveryScore: 80, distribuicaoSaldos })

  // Mesmo racional do teste de recoveryScore acima: diasAtraso a partir do
  // vencimento realmente persistido, não do que foi enviado no insert.
  const diasAtrasoReal = diasAtrasoDe(conta.vencimento)
  const dias_atraso_esperado = Math.round(20 * Math.min(1, diasAtrasoReal / 90))

  assert.equal(componentes.valor_divida.valor, Math.round(35 * 0.6)) // 21
  assert.equal(componentes.dias_atraso.valor, dias_atraso_esperado)
  assert.equal(componentes.recuperabilidade.valor, Math.round(25 * 0.8)) // 20
  assert.equal(componentes.promessa_quebrada.valor, 10) // PESO.promessa_quebrada, teve quebrada
  assert.equal(componentes.interacao_recente.valor, 10) // PESO.interacao_recente, respondeu <7 dias

  const esperado = Math.round(35 * 0.6) + dias_atraso_esperado + Math.round(25 * 0.8) + 10 + 10
  assert.equal(score, esperado)
})

test('priorityScore: sem promessa quebrada, sem interação recente, sem recoveryScore fornecido -> neutro 50% em recuperabilidade', async () => {
  const conta = await criarContaDeTeste(supabase, {
    pessoa_nome: `Teste Priority Neutro ${Date.now()}`,
    valor: 500,
    valor_pago: 0,
    status: 'vencida',
    vencimento: diasAtras(0),
  })

  const { componentes } = await calcularPriorityScore(conta.id, { distribuicaoSaldos: [500] })

  assert.equal(componentes.promessa_quebrada.valor, 0)
  assert.equal(componentes.interacao_recente.valor, 0)
  assert.equal(componentes.recuperabilidade.valor, Math.round(25 * 0.5)) // sem recoveryScore -> neutro 50%
  assert.equal(componentes.valor_divida.valor, 35) // único valor na distribuição -> percentil 1.0 -> peso cheio
})
