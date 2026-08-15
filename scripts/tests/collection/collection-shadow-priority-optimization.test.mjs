// 2026-08-15 — prova de equivalência da otimização de performance conectada
// em collection-shadow.js: carregarDistribuicaoSaldos() agora é chamada 1x
// por ciclo (fora do loop de contas) em vez de 1x por conta (a otimização já
// existia em priorityScore.js desde a FASE B.5, mas nunca tinha sido ligada
// no cron real — só testada isoladamente em priority-score-otimizacao.test.mjs).
// Esta suíte prova, contra o CÓDIGO REAL de runCollectionShadow(), que:
//   1. o score persistido pelo ciclo otimizado é IDÊNTICO ao calculado pelo
//      caminho antigo (calcularPriorityScore sem distribuicaoSaldos) para as
//      mesmas contas — nenhuma mudança de fórmula/peso/resultado;
//   2. "1x por ciclo, não 1x por conta" é garantido por CONSTRUÇÃO do código
//      (chamada única fora do loop em collection-shadow.js, uma variável
//      reusada em todas as iterações) — não há como esse teste (nem nenhum
//      teste black-box) diferenciar "1 chamada" de "N chamadas que retornam
//      o mesmo resultado" sem instrumentar o módulo, e mock.method do
//      node:test não suporta reatribuir export nomeado de ESM (confirmado:
//      TypeError "Cannot redefine property"). A garantia aqui é por leitura
//      do diff (1 call site, fora do loop), não por contagem em runtime;
//   3. shadow continua 100% read-only pro lado de cobrança/envio (nenhuma
//      linha nova em cobrancas_whatsapp/collection_dispatches).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

test('collection-shadow.js: otimização de distribuição conectada ao cron real, sem alterar resultado', async (t) => {
  await iniciarAmbienteDeTeste()
  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { runCollectionShadow } = await import('../../../src/jobs/collection-shadow.js')
  const { calcularPriorityScore } = await import('../../../src/lib/collection/priorityScore.js')
  const { calcularRecoveryScore } = await import('../../../src/lib/collection/recoveryScore.js')
  const { invalidarCacheFlags } = await import('../../../src/lib/collection/featureFlags.js')

  await t.test('score persistido pelo ciclo (com distribuição pré-carregada) == calcularPriorityScore isolado (sem pré-carregar) para as mesmas contas', async () => {
    const contas = await Promise.all([
      criarContaDeTeste(supabase, { valor: 120, valor_pago: 0 }),
      criarContaDeTeste(supabase, { valor: 780, valor_pago: 0 }),
      criarContaDeTeste(supabase, { valor: 3200, valor_pago: 0 }),
      criarContaDeTeste(supabase, { valor: 45, valor_pago: 10 }),
      criarContaDeTeste(supabase, { valor: 15000, valor_pago: 0 }),
    ])

    // "Antes" — cada conta calculada isoladamente, sem distribuição
    // pré-carregada (caminho que existia antes desta conexão). Precisa do
    // MESMO recoveryScore que o shadow vai usar (senão a comparação não é
    // justa: sem passar recoveryScore, calcularPriorityScore cai no neutro
    // 50%, mascarando a otimização com uma diferença de outro componente).
    const antesPorConta = new Map()
    for (const conta of contas) {
      const recovery = await calcularRecoveryScore(conta.id)
      antesPorConta.set(conta.id, await calcularPriorityScore(conta.id, { recoveryScore: recovery.score }))
    }

    await supabase.from('automacoes_config').update({ score_shadow_mode: true, nba_shadow_mode: false, shadow_max_customers: 1000 }).eq('id', 1)
    invalidarCacheFlags()

    const resumo = await runCollectionShadow()
    assert.ok(resumo.comScore >= contas.length, 'deveria ter calculado score para pelo menos as contas criadas neste teste')

    for (const conta of contas) {
      const { data: persistido } = await supabase
        .from('collection_priority_scores')
        .select('score, componentes')
        .eq('contas_financeiras_id', conta.id)
        .order('calculado_em', { ascending: false })
        .limit(1)
        .single()

      const antes = antesPorConta.get(conta.id)
      assert.equal(persistido.score, antes.score, `score deveria ser idêntico pra conta ${conta.id} (saldo ${conta.valor - conta.valor_pago})`)
      assert.deepEqual(
        persistido.componentes.valor_divida, antes.componentes.valor_divida,
        'componente valor_divida (o único afetado pela otimização de percentil) deveria ser byte-a-byte igual'
      )
    }

    await supabase.from('automacoes_config').update({ score_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
    invalidarCacheFlags()
  })

  await t.test('shadow continua 100% read-only pro lado de cobrança/envio — nenhuma linha nova em cobrancas_whatsapp/collection_dispatches', async () => {
    const conta = await criarContaDeTeste(supabase, { valor: 900, valor_pago: 0 })
    const { count: cobrancasAntes } = await supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true })
    const { count: dispatchesAntes } = await supabase.from('collection_dispatches').select('id', { count: 'exact', head: true })

    await supabase.from('automacoes_config').update({ score_shadow_mode: true, nba_shadow_mode: true, shadow_max_customers: 1000 }).eq('id', 1)
    invalidarCacheFlags()
    await runCollectionShadow()

    const { count: cobrancasDepois } = await supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true })
    const { count: dispatchesDepois } = await supabase.from('collection_dispatches').select('id', { count: 'exact', head: true })
    assert.equal(cobrancasDepois, cobrancasAntes, 'ciclo shadow (score+NBA) nunca deveria escrever em cobrancas_whatsapp')
    assert.equal(dispatchesDepois, dispatchesAntes, 'ciclo shadow (score+NBA) nunca deveria criar collection_dispatches')

    await supabase.from('automacoes_config').update({ score_shadow_mode: false, nba_shadow_mode: false, shadow_max_customers: 50 }).eq('id', 1)
    invalidarCacheFlags()
  })

  await pararAmbienteDeTeste()
})
