import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { runEvolutionHealthCheck } from '../jobs/evolution-health.js'

const router = Router()

// GET /api/admin/evolution-health — último status + histórico recente
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('evolution_health')
      .select('id, verificado_em, status, latencia_ms, alerta_enviado')
      .order('verificado_em', { ascending: false })
      .limit(20)

    if (error) throw error

    const ultimo = data?.[0] ?? null
    const historico = data || []

    // Uptime das últimas 24h (% de registros com status 'open')
    const ultimas24h = historico.filter(
      (r) => new Date(r.verificado_em).getTime() > Date.now() - 24 * 60 * 60 * 1000
    )
    const totalAmostras = ultimas24h.length
    const amostrasOk = ultimas24h.filter((r) => r.status === 'open').length
    const uptime24h = totalAmostras > 0 ? Math.round((amostrasOk / totalAmostras) * 100) : null

    res.json({ ultimo, historico, uptime24h })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/admin/evolution-health/check — disparo manual da verificação
router.post('/check', async (req, res) => {
  try {
    const resultado = await runEvolutionHealthCheck()
    res.json({ sucesso: true, ...resultado })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
