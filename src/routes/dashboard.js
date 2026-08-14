import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'

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

  const [r1, r2, r3, r4, r5, r6, r7, r8, r9, r10] = await Promise.all([
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
      // Só "faturado" conta como venda de verdade — rascunho e confirmado
      // ainda não viraram nota fiscal, não são receita realizada.
      // classificacao_faturamento (preenchida pelo módulo de NF-e ao
      // vincular a Série 1 autorizada) exclui bonificação/outra
      // operação/não-fiscal quando já classificado. Pedido antigo do
      // legado, ainda não passado por esse fluxo, fica com essa coluna
      // NULL — tratado como venda (comportamento histórico preservado,
      // não reclassificado às cegas).
      (() => {
        let q = supabase.from('pedidos').select('total', { count: 'exact' })
          .eq('status', 'faturado')
          .or('classificacao_faturamento.eq.venda,classificacao_faturamento.is.null')
          .gte('criado_em', inicioMes).lte('criado_em', fimMes)
        // 2026-08-04: card "Pedidos do Mês" era o único indicador deste
        // endpoint sem filtro por vendedor — todo vendedor via o total da
        // empresa inteira, não só o próprio. Corrigido pra seguir o mesmo
        // padrão dos demais (leads, tarefas, ligações) acima.
        if (filtrarPorVendedor) q = q.eq('vendedor_id', filtroVendedorId)
        return q
      })().then(({ data, count, error }) => {
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

    // VENDAS DO MÊS (fiscal) — 2026-08-14: indicador DIFERENTE de
    // "Pedidos do Mês" (r6 acima). Fonte: notas_fiscais_netvision (read
    // model espelhado de EN_Notas), regra homologada = nota válida
    // (cancelada=0) + CFOP classificado VENDA (hoje só 5102/6102,
    // ver VENDAS_DO_MES_RECONCILIACAO.md) + data_emissao no período.
    // NÃO usa pedidos.total — pedido ≠ venda fiscal realizada (achado
    // desta rodada: pedido conta valor cheio mesmo quando só uma fração
    // foi faturada, e conta pedidos que viraram bonificação/remessa).
    // Filtro por vendedor NÃO aplicado aqui ainda: representante_codigo é
    // o código do NetVision, espaço de ID diferente de usuarios.id — cruzar
    // os dois exige o mesmo casamento por nome que sync-pedidos-legado.js
    // já faz (buscarMapaVendedores), não replicado aqui por ora. O
    // indicador retorna sempre o total geral + a quebra por representante
    // (nome bruto do NetVision), sem filtro por vendedor logado.
    safe(
      supabase.from('notas_fiscais_netvision')
        .select('valor_nota, representante_codigo, representante_nome')
        .eq('codigo_filial', '001')
        .eq('cfop_classificacao', 'VENDA')
        .eq('cancelada', 0)
        .gte('data_emissao', inicioMes.slice(0, 10))
        .lte('data_emissao', fimMes.slice(0, 10))
        .then(({ data, error }) => {
          if (error) throw error
          const porRepresentante = {}
          let valorTotal = 0
          for (const n of data ?? []) {
            const chave = n.representante_nome || n.representante_codigo || 'Sem representante'
            if (!porRepresentante[chave]) porRepresentante[chave] = { codigo: n.representante_codigo, quantidade: 0, valor: 0 }
            porRepresentante[chave].quantidade++
            porRepresentante[chave].valor += Number(n.valor_nota) || 0
            valorTotal += Number(n.valor_nota) || 0
          }
          return { disponivel: true, quantidade: (data ?? []).length, valor: valorTotal, por_representante: porRepresentante }
        }),
      // `disponivel: false` — nunca confundir com "zero vendas real". Cai
      // aqui se notas_fiscais_netvision ainda não existe em produção (a
      // migration pode não ter sido aplicada ainda) ou qualquer outro erro
      // de consulta — o resto do dashboard continua funcionando normalmente
      // (safe() garante isso), só este indicador fica marcado indisponível
      // pro frontend não desenhar R$0,00 como se fosse dado fiscal confirmado.
      { disponivel: false, quantidade: 0, valor: 0, por_representante: {} }
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
    vendas_fiscais_mes: r10.value,
    gerado_em:      new Date().toISOString(),
  })
})

// GET /api/dashboard/atendimento — indicadores de espera de resposta no WhatsApp
// (Fase 3 do atendimento avançado): reaproveita get_ultima_mensagem_por_lead (Fase 1)
// pra não duplicar a lógica de "aguardando_vendedor" já usada em /whatsapp/status-espera.
router.get('/atendimento', async (req, res) => {
  try {
    let filtroVendedorId = null
    if (req.user.role === 'vendedor') filtroVendedorId = req.user.id
    else if (req.user.role === 'admin' && req.query.vendedor_id) filtroVendedorId = req.query.vendedor_id

    // Só leads ativos — 'fechado'/'perdido' são os estados terminais do funil.
    // Paginado: PostgREST limita a 1000 linhas por padrão — sem isso, com milhares de
    // leads ativos, os indicadores contavam só os primeiros 1000.
    const leads = []
    const PAGE_LEADS = 1000
    for (let offset = 0; ; offset += PAGE_LEADS) {
      let leadsQuery = supabase
        .from('leads')
        .select('id, responsavel_id, usuarios!leads_responsavel_id_fkey(nome)')
        .not('etapa', 'in', '(fechado,perdido)')
        .range(offset, offset + PAGE_LEADS - 1)
      if (filtroVendedorId) leadsQuery = leadsQuery.eq('responsavel_id', filtroVendedorId)
      const { data, error } = await leadsQuery
      if (error) throw error
      leads.push(...data)
      if (data.length < PAGE_LEADS) break
    }

    if (leads.length === 0) {
      return res.json({
        aguardando_agora: 0,
        criticas: 0,
        tempo_medio_primeira_resposta_min: null,
        pendencias_por_vendedor: [],
      })
    }

    const leadsPorId = new Map(leads.map((l) => [l.id, l]))
    const leadIds = leads.map((l) => l.id)

    // Paginado: PostgREST limita a 1000 linhas por padrão, inclusive em RPC.
    const ultimaPorLead = []
    const PAGE = 1000
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase
        .rpc('get_ultima_mensagem_por_lead', { p_lead_ids: leadIds })
        .range(offset, offset + PAGE - 1)
      if (error) throw error
      ultimaPorLead.push(...data)
      if (data.length < PAGE) break
    }

    const agora = Date.now()
    let aguardandoAgora = 0
    let criticas = 0
    const pendenciasPorVendedor = new Map() // responsavel_id (ou 'sem_vendedor') -> resumo

    for (const item of ultimaPorLead) {
      if (item.direcao !== 'entrada') continue
      const lead = leadsPorId.get(item.lead_id)
      if (!lead) continue

      const minutos = (agora - new Date(item.created_at).getTime()) / 60000
      aguardandoAgora++
      const critica = minutos >= 30
      if (critica) criticas++

      const chave = lead.responsavel_id || 'sem_vendedor'
      if (!pendenciasPorVendedor.has(chave)) {
        pendenciasPorVendedor.set(chave, {
          vendedor_id: lead.responsavel_id,
          nome: lead.usuarios?.nome || 'Sem vendedor',
          aguardando: 0,
          criticas: 0,
        })
      }
      const resumo = pendenciasPorVendedor.get(chave)
      resumo.aguardando++
      if (critica) resumo.criticas++
    }

    // Tempo médio de primeira resposta: pra cada lead ativo, mede o intervalo entre
    // uma mensagem de entrada e a próxima de saída que vier depois dela, nos últimos
    // 7 dias — calculado em JS (sem RPC nova) pra não depender de outra migration.
    // Sem filtro por lead_id na query (evita um IN(...) gigante com milhares de ids);
    // filtra em memória contra leadsPorId, que já é só os leads ativos.
    const seteDiasAtras = new Date(agora - 7 * 24 * 60 * 60 * 1000).toISOString()
    const mensagensRecentes = []
    const PAGE_MSG = 1000
    for (let offset = 0; ; offset += PAGE_MSG) {
      const { data, error } = await supabase
        .from('whatsapp_mensagens')
        .select('lead_id, direcao, created_at')
        .gte('created_at', seteDiasAtras)
        .order('created_at', { ascending: true })
        .range(offset, offset + PAGE_MSG - 1)
      if (error) throw error
      mensagensRecentes.push(...data)
      if (data.length < PAGE_MSG) break
    }

    const mensagensPorLead = new Map()
    for (const m of mensagensRecentes) {
      if (!leadsPorId.has(m.lead_id)) continue
      if (!mensagensPorLead.has(m.lead_id)) mensagensPorLead.set(m.lead_id, [])
      mensagensPorLead.get(m.lead_id).push(m)
    }

    const temposResposta = []
    for (const mensagens of mensagensPorLead.values()) {
      let aguardandoDesde = null
      for (const m of mensagens) {
        if (m.direcao === 'entrada') {
          if (aguardandoDesde === null) aguardandoDesde = m.created_at
        } else if (m.direcao === 'saida' && aguardandoDesde !== null) {
          temposResposta.push((new Date(m.created_at).getTime() - new Date(aguardandoDesde).getTime()) / 60000)
          aguardandoDesde = null
        }
      }
    }
    const tempoMedio = temposResposta.length > 0
      ? temposResposta.reduce((a, b) => a + b, 0) / temposResposta.length
      : null

    res.json({
      aguardando_agora: aguardandoAgora,
      criticas,
      tempo_medio_primeira_resposta_min: tempoMedio !== null ? Math.round(tempoMedio) : null,
      pendencias_por_vendedor: [...pendenciasPorVendedor.values()].sort((a, b) => b.aguardando - a.aguardando),
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
