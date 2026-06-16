import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/dashboard — métricas consolidadas
router.get('/', async (req, res) => {
  try {
    const hoje = new Date()
    const inicioDia = new Date(hoje.setHours(0, 0, 0, 0)).toISOString()
    const fimDia = new Date(hoje.setHours(23, 59, 59, 999)).toISOString()

    const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1).toISOString()
    const fimMes = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0, 23, 59, 59).toISOString()

    const [
      leadsPorEtapa,
      totalNegociacao,
      fechamentosMes,
      conversasHoje,
      tarefasVencendo,
      pedidosMes,
    ] = await Promise.all([
      // Contagem de leads agrupados por etapa
      supabase
        .from('leads')
        .select('etapa')
        .then(({ data, error }) => {
          if (error) throw error
          return data.reduce((acc, l) => {
            acc[l.etapa] = (acc[l.etapa] || 0) + 1
            return acc
          }, {})
        }),

      // Soma do valor em negociação (etapas ativas)
      supabase
        .from('leads')
        .select('valor_negociacao')
        .in('etapa', ['contato', 'proposta', 'negociacao'])
        .then(({ data, error }) => {
          if (error) throw error
          return data.reduce((sum, l) => sum + (Number(l.valor_negociacao) || 0), 0)
        }),

      // Leads fechados no mês atual
      supabase
        .from('leads')
        .select('id, valor_negociacao', { count: 'exact' })
        .eq('etapa', 'fechado')
        .gte('updated_at', inicioMes)
        .lte('updated_at', fimMes)
        .then(({ data, count, error }) => {
          if (error) throw error
          const valor = data.reduce((sum, l) => sum + (Number(l.valor_negociacao) || 0), 0)
          return { quantidade: count, valor }
        }),

      // Conversas WhatsApp recebidas hoje
      supabase
        .from('whatsapp_mensagens')
        .select('id', { count: 'exact' })
        .eq('direcao', 'entrada')
        .gte('created_at', inicioDia)
        .lte('created_at', fimDia)
        .then(({ count, error }) => {
          if (error) throw error
          return count
        }),

      // Tarefas vencendo hoje ou atrasadas
      supabase
        .from('tarefas')
        .select('id', { count: 'exact' })
        .lte('data_vencimento', fimDia)
        .neq('status', 'concluida')
        .then(({ count, error }) => {
          if (error) throw error
          return count
        }),

      // Total de pedidos confirmados no mês
      supabase
        .from('pedidos')
        .select('total', { count: 'exact' })
        .neq('status', 'cancelado')
        .gte('created_at', inicioMes)
        .lte('created_at', fimMes)
        .then(({ data, count, error }) => {
          if (error) throw error
          const valor = data.reduce((sum, p) => sum + (Number(p.total) || 0), 0)
          return { quantidade: count, valor }
        }),
    ])

    res.json({
      leads: {
        por_etapa: leadsPorEtapa,
        total: Object.values(leadsPorEtapa).reduce((a, b) => a + b, 0),
      },
      negociacao: {
        valor_total: totalNegociacao,
      },
      fechamentos_mes: fechamentosMes,
      whatsapp: {
        conversas_hoje: conversasHoje,
      },
      tarefas: {
        pendentes_ou_atrasadas: tarefasVencendo,
      },
      pedidos_mes: pedidosMes,
      gerado_em: new Date().toISOString(),
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
