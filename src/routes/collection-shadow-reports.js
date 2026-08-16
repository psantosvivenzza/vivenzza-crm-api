// FASE B.2 (homologação, 2026-08-11) — API de LEITURA para a visualização do
// motor de cobrança v2 dentro do ERP (Aging Report + Cobranças → Inteligência/
// Próximas Ações). Só GET. Nenhuma rota aqui recalcula score, executa NBA,
// chama Evolution ou muta qualquer tabela financeira — todas leem dados JÁ
// persistidos (collection_recovery_scores/collection_priority_scores/
// nba_shadow_log), o mesmo padrão de collection-scores.js/collection-nba.js
// (GET só lê; recalcular exigiria um POST explícito, que não existe aqui).
//
// Sem N+1: cada endpoint faz um número fixo e pequeno de queries (nunca 1 por
// cliente) e junta os dados em memória — o volume é sempre limitado por
// shadow_max_customers (hoje 50), então isso é seguro e simples sem precisar
// de uma function nova no Postgres (nenhuma migration neste PR).
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { diasAtrasoDe } from '../lib/collection/collectionContactPolicy.js'

const router = Router()

// Mantém só a linha mais recente por contas_financeiras_id de uma lista
// ordenada por data desc — usado pra simular "DISTINCT ON" sem precisar de
// SQL cru (o compat client de dev local não expõe rpc() genérico para isso).
function maisRecentePorConta(linhas) {
  const mapa = new Map()
  for (const linha of linhas) {
    if (!mapa.has(linha.contas_financeiras_id)) mapa.set(linha.contas_financeiras_id, linha)
  }
  return mapa
}

async function buscarUltimosScoresENba() {
  const [{ data: recoveries, error: e1 }, { data: priorities, error: e2 }, { data: nbas, error: e3 }] = await Promise.all([
    supabase.from('collection_recovery_scores').select('contas_financeiras_id, score, componentes, explicacao, calculado_em').order('calculado_em', { ascending: false }),
    supabase.from('collection_priority_scores').select('contas_financeiras_id, score, componentes, explicacao, calculado_em').order('calculado_em', { ascending: false }),
    supabase.from('nba_shadow_log').select('contas_financeiras_id, nba_suggested_action, nba_reason_codes, legacy_action, effective_legacy_action, blocked_reason, criado_em').order('criado_em', { ascending: false }),
  ])
  if (e1) throw e1
  if (e2) throw e2
  if (e3) throw e3
  return { recoveryPorConta: maisRecentePorConta(recoveries ?? []), priorityPorConta: maisRecentePorConta(priorities ?? []), nbaPorConta: maisRecentePorConta(nbas ?? []) }
}

async function buscarContasFinanceiras(ids) {
  if (!ids.length) return new Map()
  const { data, error } = await supabase
    .from('contas_financeiras')
    .select('id, pessoa_nome, valor, valor_pago, vencimento, telefone_cobranca, codigo_cliente, status, em_revisao_financeira')
    .in('id', ids)
  if (error) throw error
  return new Map((data ?? []).map((c) => [c.id, c]))
}

// 2026-08-16 — fila operacional (PASSO seguinte ao baseline validado). Tabela
// collection_timeline_events é pequena (154 linhas em produção hoje) — 1
// leitura completa, reduzida em memória pra "última interação por título",
// mesmo padrão de maisRecentePorConta() acima (sem N+1, sem função nova no
// Postgres).
async function buscarUltimaInteracaoPorConta() {
  const { data, error } = await supabase
    .from('collection_timeline_events')
    .select('contas_financeiras_id, tipo, criado_em')
    .order('criado_em', { ascending: false })
  if (error) throw error
  return maisRecentePorConta(data ?? [])
}

function percentil(arr, p) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.floor(s.length * p))
  return s[idx]
}
function faixaScore(score) {
  if (score == null) return null
  if (score <= 25) return '0-25'
  if (score <= 50) return '26-50'
  if (score <= 75) return '51-75'
  return '76-100'
}

// Rótulo de risco em português pro priority_score (não recovery_score — priority
// já incorpora recovery como um dos 5 componentes, ver priorityScore.js:1-2, então
// é a medida mais próxima de "risco de cobrança" que já existe). Mesmos cortes de
// faixaScore() acima, só com nome pra gente que lê o painel — nenhum cálculo novo,
// nenhuma tabela nova (achado do mapeamento do backlog "SCORE/RÉGUA": pedido de
// nomenclatura de faixa era a única lacuna real sobre score já pronto e testado).
function faixaRisco(priorityScore) {
  if (priorityScore == null) return null
  if (priorityScore <= 25) return 'BAIXO RISCO'
  if (priorityScore <= 50) return 'ATENÇÃO'
  if (priorityScore <= 75) return 'ALTO RISCO'
  return 'CRÍTICO'
}

// GET /api/collection-shadow/summary
router.get('/summary', async (req, res) => {
  try {
    const { recoveryPorConta, priorityPorConta, nbaPorConta } = await buscarUltimosScoresENba()
    const recoveryScores = [...recoveryPorConta.values()].map((r) => r.score)
    const priorityScores = [...priorityPorConta.values()].map((r) => r.score)

    const distribuicaoRecovery = { '0-25': 0, '26-50': 0, '51-75': 0, '76-100': 0 }
    for (const s of recoveryScores) distribuicaoRecovery[faixaScore(s)]++
    const distribuicaoPriority = { '0-25': 0, '26-50': 0, '51-75': 0, '76-100': 0 }
    for (const s of priorityScores) distribuicaoPriority[faixaScore(s)]++

    const nbaPorAcao = {}
    for (const nba of nbaPorConta.values()) nbaPorAcao[nba.nba_suggested_action] = (nbaPorAcao[nba.nba_suggested_action] ?? 0) + 1

    const ultimaAnalise = [...recoveryPorConta.values()].reduce((max, r) => (!max || r.calculado_em > max ? r.calculado_em : max), null)

    res.json({
      shadow_badge: 'SHADOW',
      clientes_analisados: recoveryPorConta.size,
      recovery: {
        n: recoveryScores.length,
        media: recoveryScores.length ? Math.round(recoveryScores.reduce((a, b) => a + b, 0) / recoveryScores.length) : null,
        max: recoveryScores.length ? Math.max(...recoveryScores) : null,
        p50: percentil(recoveryScores, 0.5),
        distribuicao: distribuicaoRecovery,
      },
      priority: {
        n: priorityScores.length,
        media: priorityScores.length ? Math.round(priorityScores.reduce((a, b) => a + b, 0) / priorityScores.length) : null,
        max: priorityScores.length ? Math.max(...priorityScores) : null,
        p50: percentil(priorityScores, 0.5),
        distribuicao: distribuicaoPriority,
      },
      nba_por_acao: nbaPorAcao,
      nba_total: nbaPorConta.size,
      ultima_analise_em: ultimaAnalise,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/collection-shadow/customers — todos os títulos com pelo menos um
// score já persistido (usado tanto pela aba Inteligência quanto para
// enriquecer o Aging Report no frontend, sem tocar em aging.js).
router.get('/customers', async (req, res) => {
  try {
    const { recoveryPorConta, priorityPorConta, nbaPorConta } = await buscarUltimosScoresENba()
    const ids = [...new Set([...recoveryPorConta.keys(), ...priorityPorConta.keys(), ...nbaPorConta.keys()])]
    const contas = await buscarContasFinanceiras(ids)

    const linhas = ids.map((id) => {
      const conta = contas.get(id)
      const recovery = recoveryPorConta.get(id)
      const priority = priorityPorConta.get(id)
      const nba = nbaPorConta.get(id)
      const saldo = conta ? Number(conta.valor || 0) - Number(conta.valor_pago || 0) : null
      return {
        contas_financeiras_id: id,
        pessoa_nome: conta?.pessoa_nome ?? null,
        telefone_cobranca: conta?.telefone_cobranca ?? null,
        saldo_em_aberto: saldo,
        dias_atraso: conta ? diasAtrasoDe(conta.vencimento) : null,
        recovery_score: recovery?.score ?? null,
        recovery_calculado_em: recovery?.calculado_em ?? null,
        priority_score: priority?.score ?? null,
        priority_calculado_em: priority?.calculado_em ?? null,
        faixa_risco: faixaRisco(priority?.score ?? null),
        nba_suggested_action: nba?.nba_suggested_action ?? null,
        nba_reason_codes: nba?.nba_reason_codes ?? null,
        nba_legacy_action: nba?.legacy_action ?? null,
        nba_effective_legacy_action: nba?.effective_legacy_action ?? null,
        nba_blocked_reason: nba?.blocked_reason ?? null,
        nba_criado_em: nba?.criado_em ?? null,
      }
    })

    res.json({ shadow_badge: 'SHADOW', data: linhas, total: linhas.length })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/collection-shadow/customers/:id — detalhe completo para "Ver análise".
router.get('/customers/:id', async (req, res) => {
  try {
    const id = req.params.id
    const [{ data: conta, error: eConta }, { data: recovery, error: eR }, { data: priority, error: eP }, { data: nba, error: eN }] = await Promise.all([
      supabase.from('contas_financeiras').select('id, pessoa_nome, valor, valor_pago, vencimento, telefone_cobranca').eq('id', id).maybeSingle(),
      supabase.from('collection_recovery_scores').select('*').eq('contas_financeiras_id', id).order('calculado_em', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('collection_priority_scores').select('*').eq('contas_financeiras_id', id).order('calculado_em', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('nba_shadow_log').select('*').eq('contas_financeiras_id', id).order('criado_em', { ascending: false }).limit(1).maybeSingle(),
    ])
    if (eConta) throw eConta
    if (eR) throw eR
    if (eP) throw eP
    if (eN) throw eN
    if (!conta) return res.status(404).json({ erro: 'Título não encontrado' })

    const saldo = Number(conta.valor || 0) - Number(conta.valor_pago || 0)
    res.json({
      shadow_badge: 'SHADOW',
      contas_financeiras_id: conta.id,
      pessoa_nome: conta.pessoa_nome,
      telefone_cobranca: conta.telefone_cobranca,
      saldo_em_aberto: saldo,
      vencimento: conta.vencimento,
      dias_atraso: diasAtrasoDe(conta.vencimento),
      recovery: recovery ? { score: recovery.score, componentes: recovery.componentes, explicacao: recovery.explicacao, calculado_em: recovery.calculado_em } : null,
      priority: priority ? { score: priority.score, faixa_risco: faixaRisco(priority.score), componentes: priority.componentes, explicacao: priority.explicacao, calculado_em: priority.calculado_em } : null,
      nba: nba ? { acao: nba.nba_suggested_action, reason_codes: nba.nba_reason_codes, legacy_action: nba.legacy_action, effective_legacy_action: nba.effective_legacy_action, blocked_reason: nba.blocked_reason, criado_em: nba.criado_em } : null,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/collection-shadow/next-actions — só os títulos que já têm uma
// decisão de NBA shadow registrada. Inclui priority_score/faixa_risco e a
// régua atual (nba_legacy_action) lado a lado com a ação sugerida — antes só
// dava pra comparar as duas olhando conta por conta em /customers/:id.
router.get('/next-actions', async (req, res) => {
  try {
    const { priorityPorConta, nbaPorConta } = await buscarUltimosScoresENba()
    const ids = [...nbaPorConta.keys()]
    const contas = await buscarContasFinanceiras(ids)

    const linhas = ids.map((id) => {
      const conta = contas.get(id)
      const nba = nbaPorConta.get(id)
      const priority = priorityPorConta.get(id)
      const saldo = conta ? Number(conta.valor || 0) - Number(conta.valor_pago || 0) : null
      return {
        contas_financeiras_id: id,
        pessoa_nome: conta?.pessoa_nome ?? null,
        saldo_em_aberto: saldo,
        dias_atraso: conta ? diasAtrasoDe(conta.vencimento) : null,
        priority_score: priority?.score ?? null,
        faixa_risco: faixaRisco(priority?.score ?? null),
        nba_suggested_action: nba.nba_suggested_action,
        nba_reason_codes: nba.nba_reason_codes,
        nba_legacy_action: nba.legacy_action ?? null,
        nba_effective_legacy_action: nba.effective_legacy_action ?? null,
        nba_blocked_reason: nba.blocked_reason ?? null,
        nba_criado_em: nba.criado_em,
      }
    })

    res.json({ shadow_badge: 'SHADOW', data: linhas, total: linhas.length })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/collection-shadow/queue — fila operacional de triagem/revisão
// humana. 100% leitura de dados JÁ persistidos (score/NBA/timeline) — não
// recalcula nada, não cria dispatch/cobrança/promessa, não muda status
// financeiro nem em_revisao_financeira. SHADOW continua sem nenhum poder de
// execução: esta rota só organiza o que já existe pra consulta/triagem
// humana, nada mais.
//
// Só títulos ATUALMENTE elegíveis (tipo=receber, status IN
// aberta/vencida/pago_parcial) entram na fila — um score/NBA "órfão" de um
// título já pago/cancelado (ex: resíduo de homologação anterior) nunca
// aparece aqui, diferente de /customers (que lista qualquer título com score
// persistido, sem checar status atual).
const ORDENACOES = Object.freeze({
  priority_desc: (a, b) => (b.priority_score ?? -1) - (a.priority_score ?? -1),
  priority_asc: (a, b) => (a.priority_score ?? 999) - (b.priority_score ?? 999),
  dias_atraso_desc: (a, b) => (b.dias_atraso ?? -Infinity) - (a.dias_atraso ?? -Infinity),
  saldo_desc: (a, b) => (b.saldo_em_aberto ?? -Infinity) - (a.saldo_em_aberto ?? -Infinity),
})

router.get('/queue', async (req, res) => {
  try {
    const { recoveryPorConta, priorityPorConta, nbaPorConta } = await buscarUltimosScoresENba()
    const idsComDado = [...new Set([...recoveryPorConta.keys(), ...priorityPorConta.keys(), ...nbaPorConta.keys()])]
    const [contas, interacoesPorConta] = await Promise.all([
      buscarContasFinanceiras(idsComDado),
      buscarUltimaInteracaoPorConta(),
    ])

    const ELEGIVEIS = new Set(['aberta', 'vencida', 'pago_parcial'])
    let linhas = idsComDado
      .filter((id) => ELEGIVEIS.has(contas.get(id)?.status))
      .map((id) => {
        const conta = contas.get(id)
        const recovery = recoveryPorConta.get(id)
        const priority = priorityPorConta.get(id)
        const nba = nbaPorConta.get(id)
        const interacao = interacoesPorConta.get(id)
        const saldo = Number(conta.valor || 0) - Number(conta.valor_pago || 0)
        return {
          contas_financeiras_id: id,
          pessoa_nome: conta.pessoa_nome,
          telefone_cobranca: conta.telefone_cobranca,
          telefone_disponivel: Boolean(conta.telefone_cobranca),
          saldo_em_aberto: saldo,
          dias_atraso: diasAtrasoDe(conta.vencimento),
          em_revisao_financeira: conta.em_revisao_financeira === true,
          status_financeiro: conta.status,
          priority_score: priority?.score ?? null,
          recovery_score: recovery?.score ?? null,
          faixa_risco: faixaRisco(priority?.score ?? null),
          reason_codes: nba?.nba_reason_codes ?? [],
          legacy_action: nba?.legacy_action ?? null,
          effective_legacy_action: nba?.effective_legacy_action ?? null,
          blocked_reason: nba?.blocked_reason ?? null,
          nba_suggested_action: nba?.nba_suggested_action ?? null,
          ultima_interacao: interacao ? { tipo: interacao.tipo, criado_em: interacao.criado_em } : null,
          calculado_em: priority?.calculado_em ?? recovery?.calculado_em ?? null,
        }
      })

    const totalElegivelNaFila = linhas.length

    // Cards/resumo — sempre sobre a base elegível INTEIRA, independente dos
    // filtros da tabela abaixo (mesmo racional de um dashboard: os cards dão
    // a visão geral, a tabela é o recorte que o usuário está olhando agora).
    const resumo = {
      total_monitorados: totalElegivelNaFila,
      atencao: linhas.filter((l) => l.faixa_risco === 'ATENÇÃO').length,
      alto_risco: linhas.filter((l) => l.faixa_risco === 'ALTO RISCO').length,
      critico: linhas.filter((l) => l.faixa_risco === 'CRÍTICO').length,
      baixo_risco: linhas.filter((l) => l.faixa_risco === 'BAIXO RISCO').length,
      revisao_humana: linhas.filter((l) => l.nba_suggested_action === 'HUMAN_REVIEW').length,
      bloqueados_por_guard: linhas.filter((l) => l.blocked_reason).length,
      sem_telefone: linhas.filter((l) => !l.telefone_disponivel).length,
    }

    // Filtros — todos opcionais, combináveis (AND).
    const { faixa, view, reason_code: reasonCode, blocked, nba_action: nbaAction, telefone } = req.query
    if (faixa) linhas = linhas.filter((l) => l.faixa_risco === faixa)
    if (view === 'revisao_humana') linhas = linhas.filter((l) => l.nba_suggested_action === 'HUMAN_REVIEW')
    if (reasonCode) linhas = linhas.filter((l) => (l.reason_codes ?? []).includes(reasonCode))
    if (blocked === 'true') linhas = linhas.filter((l) => Boolean(l.blocked_reason))
    else if (blocked === 'false') linhas = linhas.filter((l) => !l.blocked_reason)
    else if (blocked) linhas = linhas.filter((l) => l.blocked_reason === blocked) // valor específico, ex: EM_REVISAO_FINANCEIRA
    if (nbaAction) linhas = linhas.filter((l) => l.nba_suggested_action === nbaAction)
    if (telefone === 'true') linhas = linhas.filter((l) => l.telefone_disponivel)
    else if (telefone === 'false') linhas = linhas.filter((l) => !l.telefone_disponivel)

    const totalFiltrado = linhas.length

    const ordenar = ORDENACOES[req.query.sort] ?? ORDENACOES.priority_desc
    linhas.sort(ordenar)

    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50))
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const inicio = (page - 1) * limit
    const pagina = linhas.slice(inicio, inicio + limit)

    res.json({
      shadow_badge: 'SHADOW — NÃO EXECUTA COBRANÇA',
      resumo,
      total_filtrado: totalFiltrado,
      page,
      limit,
      total_paginas: Math.max(1, Math.ceil(totalFiltrado / limit)),
      data: pagina,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
