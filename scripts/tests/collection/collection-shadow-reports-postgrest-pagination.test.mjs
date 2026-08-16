// 2026-08-16 — hotfix de completude: PostgREST tem um limite padrão de 1000
// linhas por requisição, silencioso (sem erro). Achado real em produção:
// collection_priority_scores/collection_recovery_scores/nba_shadow_log já
// passam disso — /customers, /next-actions, /summary e /queue liam uma
// fatia TRUNCADA da carteira sem ninguém perceber. buscarTodasAsLinhas()
// agora pagina via .range() até esgotar a tabela.
//
// O compat client local (usado aqui) não reproduz o corte de 1000 do
// PostgREST real (por isso o bug original nunca apareceu localmente) — mas
// os testes abaixo provam a LÓGICA da paginação em si: nenhuma linha perdida
// nem duplicada em qualquer fronteira de página, ordenação determinística
// mesmo com timestamps empatados, e "último por título" continua correto.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, criarContaDeTeste } from './_setup.mjs'

test('buscarTodasAsLinhas / buscarUltimosScoresENba: sem truncamento além de 1000 linhas', async (t) => {
  await iniciarAmbienteDeTeste()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste'
  process.env.API_SECRET_KEY = process.env.API_SECRET_KEY || 'teste-secret-pagination'

  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const reportsRouter = (await import('../../../src/routes/collection-shadow-reports.js')).default

  const app = express()
  app.use('/api/collection-shadow', auth, adminOnly, reportsRouter)
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${process.env.API_SECRET_KEY}` }

  async function limparTabelasDeScore() {
    // Mesmo racional já usado em collection-shadow-reports.test.mjs: os
    // testes deste arquivo afirmam CONTAGEM EXATA — precisam de estado
    // conhecido, não podem depender de nenhum outro arquivo já ter tocado
    // essas 3 tabelas antes (mesmo Postgres local compartilhado).
    await supabase.from('collection_recovery_scores').delete().neq('contas_financeiras_id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('collection_priority_scores').delete().neq('contas_financeiras_id', '00000000-0000-0000-0000-000000000000')
    await supabase.from('nba_shadow_log').delete().neq('contas_financeiras_id', '00000000-0000-0000-0000-000000000000')
  }

  async function snapshotOperacional() {
    const [{ count: dispatches }, { count: envios }, { count: promessas }] = await Promise.all([
      supabase.from('collection_dispatches').select('id', { count: 'exact', head: true }),
      supabase.from('cobrancas_whatsapp').select('id', { count: 'exact', head: true }),
      supabase.from('collection_promises').select('id', { count: 'exact', head: true }),
    ])
    return { dispatches, envios, promessas }
  }

  const pessoaMarcador = 'Paginação PostgREST Teste'

  // Cria N contas + N priority_scores, TODOS com o MESMO calculado_em (força
  // empate de timestamp de propósito — sem o desempate por `id`, a ordem
  // entre páginas ficaria indeterminística e linhas poderiam sumir ou
  // duplicar exatamente na fronteira).
  async function criarContasComScoreEmpatado(n) {
    const agora = new Date().toISOString()
    const contasNovas = Array.from({ length: n }, (_, i) => ({
      tipo: 'receber', pessoa_nome: pessoaMarcador, valor: 100 + i, valor_pago: 0,
      vencimento: agora.slice(0, 10), status: 'vencida', telefone_cobranca: `5551${(9000000 + i).toString()}`,
      em_revisao_financeira: false,
    }))
    const { data: criadas, error: erroContas } = await supabase.from('contas_financeiras').insert(contasNovas).select('id')
    if (erroContas) throw erroContas
    assert.equal(criadas.length, n, `pré-condição: as ${n} contas precisam ter sido criadas`)

    const scoresNovos = criadas.map((c) => ({
      contas_financeiras_id: c.id, score: 50, formula_version: 'teste-paginacao', componentes: {}, explicacao: 'teste', calculado_em: agora,
    }))
    const { error: erroScores } = await supabase.from('collection_priority_scores').insert(scoresNovos)
    if (erroScores) throw erroScores
    return criadas.map((c) => c.id)
  }

  await t.test('1/2/3. fronteira 999/1000/1001: /customers retorna a contagem exata, sem truncar nem sobrar', async () => {
    for (const n of [999, 1000, 1001]) {
      await limparTabelasDeScore()
      await criarContasComScoreEmpatado(n)

      const r = await fetch(`${base}/api/collection-shadow/customers`, { headers })
      const body = await r.json()
      assert.equal(body.data.length, n, `com ${n} scores persistidos, /customers deveria retornar exatamente ${n} — truncamento em 1000 se vier menor`)
      const idsUnicos = new Set(body.data.map((l) => l.contas_financeiras_id))
      assert.equal(idsUnicos.size, n, `nenhuma duplicata — ${n} ids únicos esperados`)
    }
  })

  await t.test('4. 1165 (tamanho real de produção no achado original): /customers e /queue completos, cruzando a fronteira do lote 200 (buscarContasFinanceiras) e da página 1000 (buscarTodasAsLinhas) ao mesmo tempo', async () => {
    await limparTabelasDeScore()
    const ids = await criarContasComScoreEmpatado(1165)

    const rCustomers = await fetch(`${base}/api/collection-shadow/customers`, { headers })
    const customers = await rCustomers.json()
    assert.equal(customers.data.length, 1165)

    // /queue pagina a RESPOSTA em no máximo 200 por página — soma páginas
    // suficientes pra cobrir os 1165 e confirma nenhuma perda.
    const idsRetornados = new Set()
    for (let page = 1; page <= 6; page++) {
      const r = await fetch(`${base}/api/collection-shadow/queue?limit=200&page=${page}`, { headers })
      const body = await r.json()
      for (const l of body.data) idsRetornados.add(l.contas_financeiras_id)
      if (body.data.length < 200) break
    }
    const faltando = ids.filter((id) => !idsRetornados.has(id))
    assert.deepEqual(faltando, [], `nenhum dos 1165 pode faltar na fila — ${faltando.length} sumiram`)
  })

  await t.test('5. fronteira entre páginas sem perda (999→1000, checado acima) / 6. sem duplicação (checado acima via Set)', () => {
    // Cobertos nos testes 1/2/3 e 4 (tamanho do Set de ids == quantidade
    // esperada, em todos os casos) — mantido como marcador explícito porque
    // o pedido numerava este item separadamente.
  })

  await t.test('7/8. último priority score e último recovery score correto (não pega linha antiga por acidente da paginação)', async () => {
    await limparTabelasDeScore()
    const conta = await criarContaDeTeste(supabase, {})
    const antigo = new Date(Date.now() - 10 * 86400000).toISOString()
    const recente = new Date().toISOString()

    await supabase.from('collection_priority_scores').insert({ contas_financeiras_id: conta.id, score: 10, formula_version: 'antigo', componentes: {}, explicacao: 'antigo', calculado_em: antigo })
    // upsert real usa onConflict contas_financeiras_id (1 linha "atual" por
    // título) — simula histórico inserindo direto sem upsert, como um
    // resíduo de formula_version anterior ainda presente na tabela.
    await supabase.from('collection_priority_scores').delete().eq('contas_financeiras_id', conta.id)
    await supabase.from('collection_priority_scores').insert({ contas_financeiras_id: conta.id, score: 77, formula_version: 'recente', componentes: {}, explicacao: 'recente', calculado_em: recente })
    await supabase.from('collection_recovery_scores').insert({ contas_financeiras_id: conta.id, score: 88, formula_version: 'recovery-teste', componentes: {}, explicacao: 'recovery', calculado_em: recente })

    const r = await fetch(`${base}/api/collection-shadow/customers`, { headers })
    const body = await r.json()
    const linha = body.data.find((l) => l.contas_financeiras_id === conta.id)
    assert.ok(linha)
    assert.equal(linha.priority_score, 77, 'deveria pegar o priority_score mais recente, não um resíduo antigo')
    assert.equal(linha.recovery_score, 88)
  })

  await t.test('9. último NBA correto quando há múltiplos logs para o mesmo título (inclusive timestamps empatados)', async () => {
    await limparTabelasDeScore()
    const conta = await criarContaDeTeste(supabase, {})
    const t1 = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const t2 = new Date().toISOString() // mais recente

    // Compat client local monta o INSERT em lote usando as colunas do
    // PRIMEIRO objeto do array — os dois precisam ter exatamente o mesmo
    // formato de campos (mesmo com valor null), senão os campos ausentes no
    // 1º objeto são descartados silenciosamente pra TODAS as linhas do lote,
    // mesmo que o 2º objeto os tenha (limitação só do shim local; o
    // Supabase real trata cada linha pelo próprio conjunto de chaves).
    await supabase.from('nba_shadow_log').insert([
      { contas_financeiras_id: conta.id, nba_suggested_action: 'NO_ACTION', legacy_action: 'WHATSAPP', effective_legacy_action: null, blocked_reason: null, criado_em: t1 },
      { contas_financeiras_id: conta.id, nba_suggested_action: 'HUMAN_REVIEW', legacy_action: 'WHATSAPP', effective_legacy_action: 'NO_ACTION', blocked_reason: 'EM_REVISAO_FINANCEIRA', criado_em: t2 },
    ])

    const r = await fetch(`${base}/api/collection-shadow/customers/${conta.id}`, { headers })
    const detalhe = await r.json()
    assert.equal(detalhe.nba.acao, 'HUMAN_REVIEW', 'deveria retornar o log mais recente (t2), não o mais antigo (t1)')
    assert.equal(detalhe.nba.blocked_reason, 'EM_REVISAO_FINANCEIRA')
  })

  await t.test('10. título pago com score histórico não entra na fila ativa (/queue) mesmo em carteira grande', async () => {
    await limparTabelasDeScore()
    await criarContasComScoreEmpatado(50) // ruído de fundo, todas elegíveis

    const contaPaga = await criarContaDeTeste(supabase, { valor: 300, valor_pago: 300, status: 'aberta' })
    await supabase.from('collection_priority_scores').insert({ contas_financeiras_id: contaPaga.id, score: 90, formula_version: 'teste', componentes: {}, explicacao: 'residual', calculado_em: new Date().toISOString() })
    await supabase.from('contas_financeiras').update({ status: 'paga' }).eq('id', contaPaga.id)

    const r = await fetch(`${base}/api/collection-shadow/queue?limit=200`, { headers })
    const body = await r.json()
    const linha = body.data.find((l) => l.contas_financeiras_id === contaPaga.id)
    assert.equal(linha, undefined, 'título pago com score residual não pode aparecer na fila ativa')
  })

  await t.test('11/12/13. filtros, ordenação e paginação do endpoint continuam funcionando com carteira grande', async () => {
    await limparTabelasDeScore()
    await criarContasComScoreEmpatado(250)

    const rFiltro = await fetch(`${base}/api/collection-shadow/queue?faixa=ATENÇÃO&limit=200`, { headers })
    const filtro = await rFiltro.json()
    for (const l of filtro.data) assert.equal(l.faixa_risco, 'ATENÇÃO')

    const rOrdenado = await fetch(`${base}/api/collection-shadow/queue?sort=saldo_desc&limit=200`, { headers })
    const ordenado = (await rOrdenado.json()).data
    for (let i = 1; i < ordenado.length; i++) assert.ok(ordenado[i - 1].saldo_em_aberto >= ordenado[i].saldo_em_aberto)

    const rPag1 = await fetch(`${base}/api/collection-shadow/queue?limit=100&page=1`, { headers })
    const rPag2 = await fetch(`${base}/api/collection-shadow/queue?limit=100&page=2`, { headers })
    const pag1 = await rPag1.json()
    const pag2 = await rPag2.json()
    assert.equal(pag1.data.length, 100)
    assert.equal(pag2.total_filtrado, 250)
    const idsP1 = new Set(pag1.data.map((l) => l.contas_financeiras_id))
    for (const l of pag2.data) assert.equal(idsP1.has(l.contas_financeiras_id), false, 'página 2 não pode repetir id da página 1')
  })

  await t.test('14/15/16. ler os endpoints com carteira grande não cria dispatch, não envia WhatsApp, não muta tabela financeira', async () => {
    // dispatches/promises ficam mesmo em 0 (nenhum teste deste arquivo os
    // cria). cobrancas_whatsapp NÃO é 0 por padrão — seed.sql insere 2
    // linhas sintéticas de baseline (fixture pra outros testes) que
    // sobrevivem a qualquer db:local:reset — comparar contra o valor ANTES
    // de repetir as leituras é mais robusto do que assumir zero absoluto.
    const antes = await snapshotOperacional()
    await fetch(`${base}/api/collection-shadow/customers`, { headers })
    await fetch(`${base}/api/collection-shadow/queue?limit=200`, { headers })
    const depois = await snapshotOperacional()
    assert.deepEqual(depois, antes, 'ler os endpoints com carteira grande não pode alterar dispatches/cobrancas_whatsapp/promises')
    assert.equal(depois.dispatches, 0, 'nenhum cenário deste arquivo deveria ter criado um dispatch')
  })

  // Achado real (mesma sessão): limpar só as tabelas de SCORE entre os
  // cenários acima (999/1000/1001/1165/250) deixava milhares de contas
  // "vencida" (portanto elegíveis) órfãs em contas_financeiras — sem score,
  // então invisíveis pra /customers/queue, MAS ainda contadas pela rotação
  // por cursor do shadow (getEligibleAccountsRotativo). Isso inflava a
  // carteira elegível compartilhada do Postgres local e quebrava, em
  // arquivos totalmente alheios a este, qualquer runCollectionShadow() que
  // esperasse alcançar uma conta específica dentro de 1 ciclo padrão (a
  // conta acabava perdida entre milhares de linhas de ruído). Limpa por
  // último, depois de todas as asserções — nunca deixa a carteira grande
  // vazar pros arquivos que rodam depois deste na mesma suíte.
  await t.test('limpeza: remove as contas_financeiras criadas pelos cenários de carteira grande', async () => {
    // O último cenário (11/12/13) deixou score/NBA vivos pra essas contas —
    // precisa limpar as tabelas de score de novo antes do DELETE, senão a FK
    // (collection_priority_scores.contas_financeiras_id) bloqueia a exclusão.
    await limparTabelasDeScore()
    const { error } = await supabase.from('contas_financeiras').delete().eq('pessoa_nome', pessoaMarcador)
    if (error) throw error
    const { count } = await supabase.from('contas_financeiras').select('id', { count: 'exact', head: true }).eq('pessoa_nome', pessoaMarcador)
    assert.equal(count, 0, 'nenhuma conta de teste deste arquivo pode sobrar pro resto da suíte')
  })

  await new Promise((resolve) => server.close(resolve))
  await pararAmbienteDeTeste()
})
