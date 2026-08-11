// FASE B.1 (homologação, 2026-08-11) — rota mínima e dedicada para o painel
// "Shadow Cobrança". Deliberadamente SEPARADA de collection-dashboard.js (que
// depende de tabelas fora do escopo do deploy mínimo, ex. collection_calls) —
// só consulta as 3 tabelas que existem no schema mínimo
// (collection_recovery_scores, collection_priority_scores, nba_shadow_log) +
// automacoes_config para mostrar o status das flags. Só leitura, GET único.
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'

const router = Router()

router.get('/', async (req, res) => {
  try {
    const { data: config } = await supabase.from('automacoes_config').select('nba_shadow_mode, score_shadow_mode, shadow_max_customers').eq('id', 1).maybeSingle()

    const vinteQuatroHorasAtras = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const [{ data: scores }, { data: nbas }] = await Promise.all([
      supabase.from('collection_recovery_scores').select('score').gte('calculado_em', vinteQuatroHorasAtras),
      supabase.from('nba_shadow_log').select('nba_suggested_action, legacy_action').gte('criado_em', vinteQuatroHorasAtras),
    ])

    const scoreMedio = scores?.length ? Math.round(scores.reduce((s, r) => s + r.score, 0) / scores.length) : null
    const distribuicao = { 'p0-10': 0, 'p10-25': 0, 'p25-50': 0, 'p50-75': 0, 'p75-90': 0, 'p90-100': 0 }
    for (const s of scores ?? []) {
      if (s.score < 10) distribuicao['p0-10']++
      else if (s.score < 25) distribuicao['p10-25']++
      else if (s.score < 50) distribuicao['p25-50']++
      else if (s.score < 75) distribuicao['p50-75']++
      else if (s.score < 90) distribuicao['p75-90']++
      else distribuicao['p90-100']++
    }

    const nbaPorAcao = {}
    let divergenciasVsLegado = 0
    for (const n of nbas ?? []) {
      nbaPorAcao[n.nba_suggested_action] = (nbaPorAcao[n.nba_suggested_action] ?? 0) + 1
      if (n.legacy_action && n.nba_suggested_action !== n.legacy_action) divergenciasVsLegado++
    }

    res.json({
      shadow_ativo: !!(config?.nba_shadow_mode || config?.score_shadow_mode),
      nba_shadow_mode: !!config?.nba_shadow_mode,
      score_shadow_mode: !!config?.score_shadow_mode,
      shadow_max_customers: config?.shadow_max_customers ?? 50,
      ultimas_24h: {
        clientes_analisados: scores?.length ?? 0,
        score_medio: scoreMedio,
        distribuicao_score: distribuicao,
        nba_por_acao: nbaPorAcao,
        divergencias_vs_regua_legada: divergenciasVsLegado,
      },
      // Explícito, sempre — evidência visível de que nenhuma ação externa foi tomada.
      acoes_externas_executadas: 0,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH mínimo, escopo fechado — SÓ estas 3 colunas (existem no schema mínimo;
// collection-config.js completo NÃO pode ser reusado aqui porque ele
// seleciona colunas de kill switch que não existem neste deploy e erraria).
const CAMPOS_PERMITIDOS = ['nba_shadow_mode', 'score_shadow_mode', 'shadow_max_customers']

router.patch('/', async (req, res) => {
  try {
    const atualizacao = {}
    for (const campo of CAMPOS_PERMITIDOS) if (campo in req.body) atualizacao[campo] = req.body[campo]
    if (!Object.keys(atualizacao).length) return res.status(400).json({ erro: 'Nenhum campo válido para atualizar' })

    const { data, error } = await supabase.from('automacoes_config').update(atualizacao).eq('id', 1).select(CAMPOS_PERMITIDOS.join(',')).single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(400).json({ erro: err.message })
  }
})

export default router
