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
      .select('tipo, status, valor')

    if (error) throw error

    const resumo = {
      a_pagar: { total: 0, vencidas: 0, pagas: 0 },
      a_receber: { total: 0, vencidas: 0, recebidas: 0 },
      saldo_previsto: 0,
    }

    for (const c of data) {
      if (c.tipo === 'pagar') {
        if (c.status === 'aberta' || c.status === 'vencida') resumo.a_pagar.total += Number(c.valor)
        if (c.status === 'vencida') resumo.a_pagar.vencidas += Number(c.valor)
        if (c.status === 'paga') resumo.a_pagar.pagas += Number(c.valor)
      } else {
        if (c.status === 'aberta' || c.status === 'vencida') resumo.a_receber.total += Number(c.valor)
        if (c.status === 'vencida') resumo.a_receber.vencidas += Number(c.valor)
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
      .in('status', ['aberta', 'vencida', 'paga'])
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
      categoria, pessoa_nome, documento_ref, observacoes, pedido_id
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
        categoria, pessoa_nome, documento_ref, observacoes,
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

// PATCH /api/financeiro/:id/baixar — marcar como paga/recebida
router.patch('/:id/baixar', async (req, res) => {
  try {
    const { data_pagamento } = req.body
    const hoje = new Date().toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('contas_financeiras')
      .update({ status: 'paga', data_pagamento: data_pagamento || hoje, updated_at: new Date().toISOString() })
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
