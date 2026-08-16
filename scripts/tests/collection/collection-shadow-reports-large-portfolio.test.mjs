// 2026-08-16 — achado real em produção: com a carteira inteira coberta pelo
// shadow (1165+ IDs únicos entre score/NBA), buscarContasFinanceiras()
// montava um único `.in('id', ids)` com TODOS os ids — URL de dezenas de
// milhares de caracteres, que o PostgREST real do Supabase rejeita (400,
// repassado como erro genérico "Bad Request"). Derrubava silenciosamente
// /customers e /next-actions (pré-existentes) e /queue (novo). O compat
// client local usado nos outros testes é mais permissivo e nunca reproduziu
// isso — por isso passou 100% localmente antes de quebrar em produção.
//
// Este teste não reproduz o erro de URL em si (o compat client aceita
// qualquer tamanho de IN) — prova a LÓGICA da correção: o lote (chunk) de
// LOTE_IDS=200 precisa juntar corretamente os resultados de várias
// requisições menores, sem perder nem duplicar nenhum título, inclusive
// exatamente na fronteira do lote (registro 200/201) e no total (220).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste } from './_setup.mjs'

const TOTAL_CONTAS = 220 // > LOTE_IDS (200) de propósito — cruza a fronteira do lote

test('buscarContasFinanceiras: carteira grande (>LOTE_IDS) não perde/duplica título nenhum', async (t) => {
  await iniciarAmbienteDeTeste()
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'teste'
  process.env.API_SECRET_KEY = process.env.API_SECRET_KEY || 'teste-secret-large-portfolio'

  const { supabase } = await import('../../../src/lib/supabase-admin.server.js')
  const { auth, adminOnly } = await import('../../../src/middleware/auth.js')
  const reportsRouter = (await import('../../../src/routes/collection-shadow-reports.js')).default

  const app = express()
  app.use('/api/collection-shadow', auth, adminOnly, reportsRouter)
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${process.env.API_SECRET_KEY}` }
  let idsCarteiraGrande = []

  await t.test('setup: 220 contas + 220 priority_scores via insert em lote (rápido, sem calcular score de verdade)', async () => {
    const agora = new Date().toISOString()
    const contasNovas = Array.from({ length: TOTAL_CONTAS }, (_, i) => ({
      tipo: 'receber',
      pessoa_nome: `Carteira Grande ${i.toString().padStart(4, '0')}`,
      valor: 100 + i,
      valor_pago: 0,
      vencimento: agora.slice(0, 10),
      status: 'vencida',
      telefone_cobranca: `55519${(90000000 + i).toString()}`,
      em_revisao_financeira: false,
    }))
    const { data: criadas, error: erroContas } = await supabase.from('contas_financeiras').insert(contasNovas).select('id')
    if (erroContas) throw erroContas
    assert.equal(criadas.length, TOTAL_CONTAS, 'pré-condição: todas as 220 contas precisam ter sido criadas')

    const scoresNovos = criadas.map((c, i) => ({
      contas_financeiras_id: c.id, score: i % 101, formula_version: 'teste-lote', componentes: {}, explicacao: 'teste carteira grande', calculado_em: agora,
    }))
    const { error: erroScores } = await supabase.from('collection_priority_scores').insert(scoresNovos)
    if (erroScores) throw erroScores

    idsCarteiraGrande = criadas.map((c) => c.id)
  })

  await t.test('/customers retorna as 220 contas, nenhuma perdida na fronteira do lote nem duplicada', async () => {
    const r = await fetch(`${base}/api/collection-shadow/customers`, { headers })
    const body = await r.json()
    const idsRetornados = new Set(body.data.map((l) => l.contas_financeiras_id))
    assert.equal(idsRetornados.size, body.data.length, 'não pode haver contas_financeiras_id duplicado na resposta')

    const idsEsperados = idsCarteiraGrande
    const faltando = idsEsperados.filter((id) => !idsRetornados.has(id))
    assert.deepEqual(faltando, [], `nenhuma das 220 contas pode faltar — ${faltando.length} sumiram (prova da perda na fronteira do lote se o chunking estivesse errado)`)
  })

  await t.test('/queue (novo endpoint) também retorna as 220 sem perda, incluindo exatamente no índice 200/201 (fronteira do lote)', async () => {
    // /queue limita a 200 por página de propósito (teto de segurança da rota,
    // não relacionado ao lote de 200 do buscarContasFinanceiras) — soma 2
    // páginas pra cobrir as 220 contas deste teste, sem misturar as duas
    // preocupações (chunking interno vs. paginação da resposta).
    const r1 = await fetch(`${base}/api/collection-shadow/queue?limit=200&page=1`, { headers })
    const r2 = await fetch(`${base}/api/collection-shadow/queue?limit=200&page=2`, { headers })
    const body1 = await r1.json()
    const body2 = await r2.json()
    const idsRetornados = new Set([...body1.data, ...body2.data].map((l) => l.contas_financeiras_id))

    const idsEsperados = idsCarteiraGrande
    // índice 199 (0-based) = o 200º id, exatamente o último do 1º lote;
    // índice 200 = o 201º id, o primeiro do 2º lote — a fronteira exata.
    assert.ok(idsRetornados.has(idsEsperados[199]), 'último id do 1º lote (índice 199) não pode faltar')
    assert.ok(idsRetornados.has(idsEsperados[200]), 'primeiro id do 2º lote (índice 200) não pode faltar')
    assert.ok(idsRetornados.has(idsEsperados[TOTAL_CONTAS - 1]), 'último id de todos (fim do 2º lote) não pode faltar')

    const faltando = idsEsperados.filter((id) => !idsRetornados.has(id))
    assert.deepEqual(faltando, [], `nenhuma das 220 contas pode faltar na fila — ${faltando.length} sumiram`)
  })

  await new Promise((resolve) => server.close(resolve))
  await pararAmbienteDeTeste()
})
