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

  // Vendedor sempre filtra pelos seus próprios dados. Admin filtra por vendedor_id
  // só quando passado via query (seletor "Empresa (geral)" / "Ana" / "Tatiane").
  let filtroVendedorId = null
  if (req.user.role === 'vendedor') {
    filtroVendedorId = req.user.id
  } else if (req.user.role === 'admin' && req.query.vendedor_id) {
    filtroVendedorId = req.query.vendedor_id
  }
  const filtrarPorVendedor = !!filtroVendedorId

  // Filtra mensagens pelos leads do vendedor - whatsapp_mensagens não tem responsavel_id direto
  let leadIdsVendedor = null
  if (filtrarPorVendedor) {
    const { data: meusLeads } = await supabase.from('leads').select('id').eq('responsavel_id', filtroVendedorId)
    leadIdsVendedor = (meusLeads || []).map((l) => l.id)
  }

  const [r1, r2, r3, r4, r5, r6, r7, r8, r9] = await Promise.all([
    safe(
      (() => {
        let q = supabase.from('leads').select('etapa')
        if (filtrarPorVendedor) q = q.eq('responsavel_id', filtroVendedorId)
        return q
      })().then(({ data, error }) => {
        if (error) throw error
        return (data ?? []).reduce((acc, l) => {
          acc[l.etapa] = (acc[l.etapa] || 0) + 1
          return acc
        }, {})
      }),
      {}
    ),

    safe(
      (() => {
        let q = supabase.from('leads').select('valor_negociacao').in('etapa', ['contato', 'proposta', 'negociacao'])
        if (filtrarPorVendedor) q = q.eq('responsavel_id', filtroVendedorId)
        return q
      })().then(({ data, error }) => {
        if (error) throw error
        return (data ?? []).reduce((sum, l) => sum + (Number(l.valor_negociacao) || 0), 0)
      }),
      0
    ),

    safe(
      (() => {
        let q = supabase.from('leads').select('id, valor_negociacao', { count: 'exact' })
          .not('fechado_em', 'is', null)
          .gte('fechado_em', inicioMes).lte('fechado_em', fimMes)
        if (filtrarPorVendedor) q = q.eq('responsavel_id', filtroVendedorId)
        return q
      })().then(({ data, count, error }) => {
        if (error) throw error
        return {
          quantidade: count ?? 0,
          valor: (data ?? []).reduce((sum, l) => sum + (Number(l.valor_negociacao) || 0), 0),
        }
      }),
      { quantidade: 0, valor: 0 }
    ),

    safe(
      (async () => {
        if (filtrarPorVendedor && leadIdsVendedor.length === 0) return 0
        let q = supabase.from('whatsapp_mensagens').select('id', { count: 'exact' })
          .eq('direcao', 'entrada').gte('created_at', inicioDia).lte('created_at', fimDia)
        if (filtrarPorVendedor) q = q.in('lead_id', leadIdsVendedor)
        const { count, error } = await q
        if (error) throw error
        return count ?? 0
      })(),
      0
    ),

    safe(
      (() => {
        let q = supabase.from('tarefas').select('id', { count: 'exact' })
          .lte('prazo', fimDia).neq('status', 'concluida')
        if (filtrarPorVendedor) q = q.eq('responsavel_id', filtroVendedorId)
        return q
      })().then(({ count, error }) => {
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

    safe(
      (() => {
        let q = supabase.from('leads').select('created_at')
          .eq('origem', 'manual')
          .gte('created_at', inicioMes).lte('created_at', fimMes)
        if (filtrarPorVendedor) q = q.eq('responsavel_id', filtroVendedorId)
        return q
      })().then(({ data, error }) => {
        if (error) throw error
        const lista = data ?? []
        return {
          hoje: lista.filter((l) => l.created_at >= inicioDia && l.created_at <= fimDia).length,
          mes: lista.length,
        }
      }),
      { hoje: 0, mes: 0 }
    ),

    safe(
      (() => {
        let q = supabase.from('ligacoes').select('id', { count: 'exact', head: true })
          .gte('iniciada_em', inicioDia).lte('iniciada_em', fimDia)
        if (filtrarPorVendedor) q = q.eq('vendedor_id', filtroVendedorId)
        return q
      })().then(({ count, error }) => {
        if (error) throw error
        return count ?? 0
      }),
      0
    ),

    safe(
      (() => {
        let q = supabase.from('ligacoes').select('id', { count: 'exact', head: true })
        if (filtrarPorVendedor) q = q.eq('vendedor_id', filtroVendedorId)
        return q
      })().then(({ count, error }) => {
        if (error) throw error
        return count ?? 0
      }),
      0
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
    leads_manuais:  r7.value,
    ligacoes:       { hoje: r8.value, total: r9.value },
    gerado_em:      new Date().toISOString(),
  })
})

export default router
