// FASE B.5 (homologação, 2026-08-11) — teste de equivalência funcional da
// otimização de performance do priority score: carregar a distribuição de
// saldos 1x por batch (carregarDistribuicaoSaldos + percentilEmDistribuicao)
// tem que produzir o MESMO score que o caminho antigo (percentilNaCarteira,
// 1 varredura completa por conta). Roda contra o banco local (estático
// durante o teste, sem concorrência) — evita o falso-positivo de comparar
// contra produção viva, onde a carteira pode mudar entre as duas chamadas.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

test('priority score: otimização (distribuição pré-carregada) é funcionalmente idêntica ao cálculo antigo', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { calcularPriorityScore, carregarDistribuicaoSaldos, percentilEmDistribuicao } = await import('../../../src/lib/collection/priorityScore.js')

  await t.test('mesmo score com e sem distribuicaoSaldos pré-carregada, para várias contas com saldos diferentes', async () => {
    const contas = await Promise.all([
      criarContaDeTeste(supabase, { valor: 100, valor_pago: 0 }),
      criarContaDeTeste(supabase, { valor: 500, valor_pago: 0 }),
      criarContaDeTeste(supabase, { valor: 2500, valor_pago: 0 }),
      criarContaDeTeste(supabase, { valor: 50, valor_pago: 10 }),
      criarContaDeTeste(supabase, { valor: 9999, valor_pago: 0 }),
    ])

    const distribuicao = await carregarDistribuicaoSaldos()

    for (const conta of contas) {
      const semOtimizacao = await calcularPriorityScore(conta.id)
      const comOtimizacao = await calcularPriorityScore(conta.id, { distribuicaoSaldos: distribuicao })
      assert.equal(comOtimizacao.score, semOtimizacao.score, `score deveria ser idêntico para conta ${conta.id} (saldo ${conta.valor - conta.valor_pago})`)
      assert.deepEqual(comOtimizacao.componentes.valor_divida, semOtimizacao.componentes.valor_divida, 'o componente de valor_divida (que usa o percentil) deveria ser byte-a-byte igual')
    }
  })

  await t.test('percentilEmDistribuicao (busca binária) é equivalente a filter().length ingênuo sobre o mesmo array', async () => {
    const distribuicao = [10, 20, 30, 30, 50, 100]
    for (const alvo of [5, 10, 25, 30, 49, 50, 100, 200]) {
      const viaBinaria = percentilEmDistribuicao(alvo, distribuicao)
      const viaFilter = distribuicao.filter((s) => s <= alvo).length / distribuicao.length
      assert.equal(viaBinaria, viaFilter, `divergência para alvo=${alvo}`)
    }
  })

  await pararAmbienteDeTeste()
})
