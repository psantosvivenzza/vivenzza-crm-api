import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/financeiro — listar contas (pagar ou receber)
router.get('/', async (req, res) => {
  try {
    const { tipo, status, vencimento_de, vencimento_ate, page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('contas_financeiras')
      .select('*', { count: 'exact' })
      .order('vencimento', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    if (tipo) query = query.eq('tipo', tipo)
    if (status) query = query.eq('status', status)
    if (vencimento_de) query = query.gte('vencimento', vencimento_de)
    if (vencimento_ate) query = query.lte('vencimento', vencimento_ate)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/financeiro/resumo — totais por tipo e status
router.get('/resumo', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contas_financeiras')
      .select('tipo, status, valor, valor_pago')

    if (error) throw error

    const resumo = {
      a_pagar: { total: 0, vencidas: 0, pagas: 0 },
      a_receber: { total: 0, vencidas: 0, recebidas: 0 },
      saldo_previsto: 0,
    }

    // Conta como "em aberto" (total/vencidas) o SALDO — valor menos o que já foi
    // pago — não o valor cheio original. Sem isso, um título com baixa parcial
    // (status='pago_parcial') mostraria o valor original inteiro aqui, inflando
    // o card mesmo depois de parte já ter sido recebida.
    for (const c of data) {
      const saldo = Number(c.valor || 0) - Number(c.valor_pago || 0)
      const emAberto = c.status === 'aberta' || c.status === 'vencida' || c.status === 'pago_parcial'
      if (c.tipo === 'pagar') {
        if (emAberto) resumo.a_pagar.total += saldo
        if (c.status === 'vencida') resumo.a_pagar.vencidas += saldo
        if (c.status === 'paga') resumo.a_pagar.pagas += Number(c.valor)
      } else {
        if (emAberto) resumo.a_receber.total += saldo
        if (c.status === 'vencida') resumo.a_receber.vencidas += saldo
        if (c.status === 'paga') resumo.a_receber.recebidas += Number(c.valor)
      }
    }

    resumo.saldo_previsto = resumo.a_receber.total - resumo.a_pagar.total

    res.json(resumo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/financeiro/fluxo-caixa — agrupado por mês (próximos 6 meses)
router.get('/fluxo-caixa', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contas_financeiras')
      .select('tipo, valor, vencimento, status')
      .in('status', ['aberta', 'vencida', 'paga', 'pago_parcial'])
      .gte('vencimento', new Date(new Date().setMonth(new Date().getMonth() - 1)).toISOString().split('T')[0])
      .lte('vencimento', new Date(new Date().setMonth(new Date().getMonth() + 6)).toISOString().split('T')[0])

    if (error) throw error

    const meses = {}
    for (const c of data) {
      const mes = c.vencimento.slice(0, 7) // "2026-06"
      if (!meses[mes]) meses[mes] = { mes, entradas: 0, saidas: 0 }
      if (c.tipo === 'receber') meses[mes].entradas += Number(c.valor)
      else meses[mes].saidas += Number(c.valor)
    }

    const fluxo = Object.values(meses)
      .sort((a, b) => a.mes.localeCompare(b.mes))
      .map(m => ({ ...m, saldo: m.entradas - m.saidas }))

    res.json(fluxo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/financeiro/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contas_financeiras')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Conta não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/financeiro — criar conta
router.post('/', async (req, res) => {
  try {
    const {
      tipo, descricao, valor, vencimento,
      categoria, categoria_dre, pessoa_nome, documento_ref, observacoes, pedido_id
    } = req.body

    if (!tipo || !descricao || !valor || !vencimento) {
      return res.status(400).json({ erro: '"tipo", "descricao", "valor" e "vencimento" são obrigatórios' })
    }

    if (!['pagar', 'receber'].includes(tipo)) {
      return res.status(400).json({ erro: '"tipo" deve ser "pagar" ou "receber"' })
    }

    const { data, error } = await supabase
      .from('contas_financeiras')
      .insert({
        tipo, descricao, valor: Number(valor), vencimento,
        categoria, categoria_dre: categoria_dre || null, pessoa_nome, documento_ref, observacoes,
        pedido_id: pedido_id || null,
        usuario_id: req.user?.id,
        status: 'aberta',
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/financeiro/:id — editar
router.put('/:id', async (req, res) => {
  try {
    const campos = { ...req.body }
    delete campos.id
    delete campos.created_at
    if (campos.valor != null) campos.valor = Number(campos.valor)
    campos.updated_at = new Date().toISOString()

    const { data, error } = await supabase
      .from('contas_financeiras')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Conta não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/financeiro/contas/:id/baixa — baixa manual (total ou parcial).
// Substitui o antigo /:id/baixar (só integral, não registrava valor_pago/forma de
// pagamento) — nada mais no código chama a rota antiga, removida abaixo.
// Vendedor só pode dar baixa em títulos vinculados a ele (vendedor_id); admin, em
// qualquer um. Muitos títulos legados têm vendedor_id nulo — nesses, só admin.
router.patch('/contas/:id/baixa', async (req, res) => {
  try {
    const { valor_recebido, data_pagamento, forma_pagamento, observacao } = req.body
    const valorRecebidoNum = Number(valor_recebido)

    if (!valorRecebidoNum || valorRecebidoNum <= 0) {
      return res.status(400).json({ erro: '"valor_recebido" deve ser maior que zero' })
    }

    const { data: conta, error: erroBusca } = await supabase
      .from('contas_financeiras')
      .select('*')
      .eq('id', req.params.id)
      .single()
    if (erroBusca) throw erroBusca
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' })

    if (req.user.role === 'vendedor' && conta.vendedor_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para dar baixa neste título' })
    }
    if (conta.status === 'paga') return res.status(400).json({ erro: 'Este título já está totalmente pago' })
    if (conta.status === 'cancelada') return res.status(400).json({ erro: 'Este título está cancelado' })

    const valorPagoAnterior = Number(conta.valor_pago || 0)
    const novoValorPago = valorPagoAnterior + valorRecebidoNum
    const novoSaldo = Number(conta.valor || 0) - novoValorPago
    const novoStatus = novoSaldo <= 0 ? 'paga' : 'pago_parcial'
    const hoje = new Date().toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('contas_financeiras')
      .update({
        valor_pago: novoValorPago,
        status: novoStatus,
        data_pagamento: data_pagamento || hoje,
        forma_pagamento: forma_pagamento || null,
        observacao_pagamento: observacao || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/financeiro/:id/cancelar
router.patch('/:id/cancelar', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contas_financeiras')
      .update({ status: 'cancelada', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Conta não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// DELETE /api/financeiro/:id
router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('contas_financeiras')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error
    res.status(204).send()
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
