import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { runEvolutionHealthCheck } from '../jobs/evolution-health.js'

const router = Router()

// Instância padrão para manter compatibilidade com quem já consome
// {ultimo, historico, uptime24h} sem passar ?instancia= (dashboard existente).
// Antes desta mudança só existia essa instância nos registros, então filtrar
// por ela reproduz exatamente o comportamento de antes.
const INSTANCIA_PADRAO = 'vivenzza'

function calcularUptime(registros) {
  const ultimas24h = registros.filter(
    (r) => new Date(r.verificado_em).getTime() > Date.now() - 24 * 60 * 60 * 1000
  )
  const totalAmostras = ultimas24h.length
  const amostrasOk = ultimas24h.filter((r) => r.status === 'open').length
  return totalAmostras > 0 ? Math.round((amostrasOk / totalAmostras) * 100) : null
}

// GET /api/admin/evolution-health — último status + histórico recente
// ?instancia=vivenzza-financeiro filtra para outra instância; sem o parâmetro,
// mantém o comportamento antigo (só a comercial), pra não quebrar quem já
// consome esse endpoint sem saber que agora existe mais de uma instância.
router.get('/', async (req, res) => {
  try {
    const instancia = req.query.instancia || INSTANCIA_PADRAO

    const { data, error } = await supabase
      .from('evolution_health')
      .select('id, verificado_em, status, latencia_ms, alerta_enviado, detalhes')
      .eq('detalhes->>instanceName', instancia)
      .order('verificado_em', { ascending: false })
      .limit(20)

    if (error) throw error

    const historico = data || []
    const ultimo = historico[0] ?? null
    const uptime24h = calcularUptime(historico)

    // Snapshot rápido das outras instâncias monitoradas, pra dar visão geral
    // sem precisar de uma chamada por instância no front.
    const { data: outras } = await supabase
      .from('evolution_health')
      .select('status, verificado_em, detalhes')
      .neq('detalhes->>instanceName', instancia)
      .order('verificado_em', { ascending: false })
      .limit(50)

    const outrasInstancias = {}
    for (const registro of outras || []) {
      const nome = registro.detalhes?.instanceName
      if (nome && !outrasInstancias[nome]) {
        outrasInstancias[nome] = { status: registro.status, verificado_em: registro.verificado_em }
      }
    }

    res.json({ instancia, ultimo, historico, uptime24h, outras_instancias: outrasInstancias })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/admin/evolution-health/check — disparo manual da verificação
// (agora roda para todas as instâncias monitoradas de uma vez; retorna um
// array em vez de um objeto único).
router.post('/check', async (req, res) => {
  try {
    const resultados = await runEvolutionHealthCheck()
    res.json({ sucesso: true, resultados })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
