import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

const safe = (promise, fallback) =>
  promise.then((r) => ({ ok: true, value: r })).catch(() => ({ ok: false, value: fallback }))

router.get('/', async (req, res) => {
  const agora = new Date()
  const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).toISOString()
  const fimDia   = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999).toISOString()
  const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1).toISOString()
  const fimMes    = new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59, 999).toISOString()

  const [r1, r2, r3, r4, r5, r6] = await Promise.all([
    safe(
      supabase.from('leads').select('etapa').then(({ data, error }) => {
        if (error) throw error
        return (data ?? []).reduce((acc, l) => {
          acc[l.etapa] = (acc[l.etapa] || 0) + 1
          return acc
        }, {})
      }),
      {}
    ),

    safe(
      supabase.from('leads').select('valor_negociacao').in('etapa', ['contato', 'proposta', 'negociacao'])
        .then(({ data, error }) => {
          if (error) throw error
          return (data ?? []).reduce((sum, l) => sum + (Number(l.valor_negociacao) || 0), 0)
        }),
      0
    ),

    safe(
      supabase.from('leads').select('id, valor_negociacao', { count: 'exact' })
        .eq('etapa', 'fechado').gte('updated_at', inicioMes).lte('updated_at', fimMes)
        .then(({ data, count, error }) => {
          if (error) throw error
          return {
            quantidade: count ?? 0,
            valor: (data ?? []).reduce((sum, l) => sum + (Number(l.valor_negociacao) || 0), 0),
          }
        }),
      { quantidade: 0, valor: 0 }
    ),

    safe(
      supabase.from('whatsapp_mensagens').select('id', { count: 'exact' })
        .eq('direcao', 'entrada').gte('created_at', inicioDia).lte('created_at', fimDia)
        .then(({ count, error }) => {
          if (error) throw error
          return count ?? 0
        }),
      0
    ),

    safe(
      supabase.from('tarefas').select('id', { count: 'exact' })
        .lte('prazo', fimDia).neq('status', 'concluida')
        .then(({ count, error }) => {
          if (error) throw error
          return count ?? 0
        }),
      0
    ),

    safe(
      supabase.from('pedidos').select('total', { count: 'exact' })
        .neq('status', 'cancelado').gte('created_at', inicioMes).lte('created_at', fimMes)
        .then(({ data, count, error }) => {
          if (error) throw error
          return {
            quantidade: count ?? 0,
            valor: (data ?? []).reduce((sum, p) => sum + (Number(p.total) || 0), 0),
          }
        }),
      { quantidade: 0, valor: 0 }
    ),
  ])

  const porEtapa = r1.value
  res.json({
    leads: {
      por_etapa: porEtapa,
      total: Object.values(porEtapa).reduce((a, b) => a + b, 0),
    },
    negociacao:     { valor_total: r2.value },
    fechamentos_mes: r3.value,
    whatsapp:       { conversas_hoje: r4.value },
    tarefas:        { pendentes_ou_atrasadas: r5.value },
    pedidos_mes:    r6.value,
    gerado_em:      new Date().toISOString(),
  })
})

export default router
