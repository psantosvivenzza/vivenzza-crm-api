import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { adminOnly } from '../middleware/auth.js'

const router = Router()

router.get('/', adminOnly, async (req, res) => {
  try {
    const trintaDiasAtras = new Date()
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30)

    const [leadsRes, leadsRecentesRes] = await Promise.all([
      supabase.from('leads').select('responsavel_id, etapa, valor_negociacao, origem, usuarios(nome)').gte('created_at', trintaDiasAtras.toISOString()),
      supabase.from('leads').select('created_at').gte('created_at', trintaDiasAtras.toISOString()),
    ])

    if (leadsRes.error) throw leadsRes.error

    const leads = leadsRes.data || []

    // 1. Performance por vendedora
    const mapaVendedoras = {}
    for (const lead of leads) {
      const id = lead.responsavel_id || '__sem_responsavel__'
      const nome = lead.usuarios?.nome || 'Sem responsável'
      if (!mapaVendedoras[id]) {
        mapaVendedoras[id] = {
          nome,
          total: 0,
          etapas: { novo: 0, contato: 0, proposta: 0, negociacao: 0, fechado: 0, perdido: 0 },
          valor_negociacao: 0,
        }
      }
      mapaVendedoras[id].total++
      const etapa = lead.etapa || 'novo'
      mapaVendedoras[id].etapas[etapa] = (mapaVendedoras[id].etapas[etapa] || 0) + 1
      if (['contato', 'proposta', 'negociacao'].includes(etapa)) {
        mapaVendedoras[id].valor_negociacao += Number(lead.valor_negociacao) || 0
      }
    }

    const performance_vendedoras = Object.values(mapaVendedoras)
      .map((v) => ({
        ...v,
        taxa_conversao: v.total > 0 ? Number(((v.etapas.fechado || 0) / v.total) * 100).toFixed(1) : '0.0',
      }))
      .sort((a, b) => b.total - a.total)

    // 2. Leads por origem e por campanha (origens que começam com 'campanha_')
    const mapaOrigens = {}
    const mapaCampanhas = {}
    for (const lead of leads) {
      const origem = lead.origem || 'manual'
      mapaOrigens[origem] = (mapaOrigens[origem] || 0) + 1

      if (origem.startsWith('campanha_')) {
        if (!mapaCampanhas[origem]) {
          mapaCampanhas[origem] = {
            origem,
            total: 0,
            etapas: { novo: 0, contato: 0, proposta: 0, negociacao: 0, fechado: 0, perdido: 0 },
            valor_negociacao: 0,
          }
        }
        mapaCampanhas[origem].total++
        const etapa = lead.etapa || 'novo'
        mapaCampanhas[origem].etapas[etapa] = (mapaCampanhas[origem].etapas[etapa] || 0) + 1
        if (['contato', 'proposta', 'negociacao'].includes(etapa)) {
          mapaCampanhas[origem].valor_negociacao += Number(lead.valor_negociacao) || 0
        }
      }
    }

    const leads_por_origem = Object.entries(mapaOrigens)
      .map(([origem, total]) => ({ origem, total }))
      .sort((a, b) => b.total - a.total)

    const leads_por_campanha = Object.values(mapaCampanhas)
      .map((c) => ({
        ...c,
        taxa_conversao: c.total > 0 ? Number(((c.etapas.fechado || 0) / c.total) * 100).toFixed(1) : '0.0',
      }))
      .sort((a, b) => b.total - a.total)

    // 3. Evolução temporal — últimos 30 dias (inclui dias sem leads)
    const porDia = {}
    for (const lead of leadsRecentesRes.data || []) {
      const dia = lead.created_at?.slice(0, 10)
      if (dia) porDia[dia] = (porDia[dia] || 0) + 1
    }

    const evolucao_temporal = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dia = d.toISOString().slice(0, 10)
      evolucao_temporal.push({ dia, total: porDia[dia] || 0 })
    }

    res.json({ performance_vendedoras, leads_por_campanha, leads_por_origem, evolucao_temporal, gerado_em: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
