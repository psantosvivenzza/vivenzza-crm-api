import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

const safe = (promise, fallback) =>
  promise.then((r) => ({ ok: true, value: r })).catch(() => ({ ok: false, value: fallback }))

// Resolve o período do filtro do Dashboard a partir de data_inicio/data_fim
// ("YYYY-MM-DD"). Sem os dois, cai no padrão "Este Mês" — mesmo comportamento
// de antes do filtro existir, então chamadas sem esses params continuam OK.
function resolverPeriodo(query) {
  const agora = new Date()
  const parseData = (str, fimDoDia) => {
    if (!str) return null
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str)
    if (!m) return null
    const [, ano, mes, dia] = m.map(Number)
    return fimDoDia
      ? new Date(ano, mes - 1, dia, 23, 59, 59, 999)
      : new Date(ano, mes - 1, dia)
  }

  const inicio = parseData(query.data_inicio, false)
    ?? new Date(agora.getFullYear(), agora.getMonth(), 1)
  const fim = parseData(query.data_fim, true)
    ?? new Date(agora.getFullYear(), agora.getMonth() + 1, 0, 23, 59, 59, 999)

  return { inicio: inicio.toISOString(), fim: fim.toISOString() }
}

router.get('/', async (req, res) => {
  const agora = new Date()
  const inicioDia = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).toISOString()
  const fimDia   = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate(), 23, 59, 59, 999).toISOString()
  const { inicio: inicioMes, fim: fimMes } = resolverPeriodo(req.query)

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

  // Etapas válidas (mesmo CHECK constraint da tabela leads) — contadas uma a uma via
  // COUNT exato (head: true, sem trazer linha nenhuma). Antes disso era um único
  // .select('etapa') sem count nem range: caía no max-rows padrão do PostgREST
  // (1000) e "total" virava a soma desse array truncado, não o total real —
  // travava em 1000 leads mesmo com a tabela tendo mais.
  const ETAPAS = ['novo', 'contato', 'proposta', 'negociacao', 'fechado', 'perdido']

  const [r1, r2, r3, r4, r5, r6, r7, r8, r9] = await Promise.all([
    safe(
      (async () => {
        const porEtapa = {}
        await Promise.all(ETAPAS.map(async (etapa) => {
          let q = supabase.from('leads').select('id', { count: 'exact', head: true }).eq('etapa', etapa)
            .gte('created_at', inicioMes).lte('created_at', fimMes)
          if (filtrarPorVendedor) q = q.eq('responsavel_id', filtroVendedorId)
          const { count, error } = await q
          if (error) throw error
          porEtapa[etapa] = count ?? 0
        }))
        return porEtapa
      })(),
      {}
    ),

    safe(
      (() => {
        let q = supabase.from('leads').select('valor_negociacao').in('etapa', ['contato', 'proposta', 'negociacao'])
          .gte('created_at', inicioMes).lte('created_at', fimMes)
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
          .eq('direcao', 'entrada').gte('created_at', inicioMes).lte('created_at', fimMes)
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
          .lte('prazo', fimMes).neq('status', 'concluida')
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
          .gte('iniciada_em', inicioMes).lte('iniciada_em', fimMes)
        if (filtrarPorVendedor) q = q.eq('vendedor_id', filtroVendedorId)
        return q
      })().then(({ count, error }) => {
        if (error) throw error
        return count ?? 0
      }),
      0
    ),

    // Histórico completo — deliberadamente sem filtro de período (card
    // "Total de Ligações" mostra o total histórico, não o do período selecionado).
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
