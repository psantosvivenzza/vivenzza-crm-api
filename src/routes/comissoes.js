import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { adminOnly } from '../middleware/auth.js'
import { calcularComissaoEstimada } from '../lib/comissoes.js'

const router = Router()

const SELECT_COMISSAO = '*, pedidos(id, clientes_erp(razao_social, nome_fantasia), leads(nome)), nfe(numero, chave)'

function intervaloMes(mes, ano) {
  const agora = new Date()
  const m = mes ? Number(mes) : agora.getUTCMonth() + 1
  const a = ano ? Number(ano) : agora.getUTCFullYear()
  const inicio = `${a}-${String(m).padStart(2, '0')}-01`
  const fim = new Date(Date.UTC(a, m, 1)).toISOString().split('T')[0]
  return { inicio, fim }
}

// Busca todas as linhas paginando em blocos de 1000 (limite padrão do PostgREST) —
// necessário aqui porque o resumo soma comissoes do mês inteiro, que pode passar de
// 1000 linhas em meses de pico.
async function buscarTodasComissoesDoMes(inicio, fim) {
  const PAGE = 1000
  let offset = 0
  let todas = []
  while (true) {
    const { data, error } = await supabase
      .from('comissoes')
      .select('vendedor_id, valor_base, valor_comissao')
      .gte('data_geracao', inicio)
      .lt('data_geracao', fim)
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    todas = todas.concat(data)
    if (!data.length || data.length < PAGE) break
    offset += PAGE
  }
  return todas
}

// GET /api/comissoes — listar (admin vê todas, vendedor só as suas)
router.get('/', async (req, res) => {
  try {
    const { vendedor_id, mes, ano, status, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('comissoes')
      .select(SELECT_COMISSAO, { count: 'exact' })
      .order('data_geracao', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (req.user.role === 'vendedor') {
      query = query.eq('vendedor_id', req.user.id)
    } else if (vendedor_id) {
      query = query.eq('vendedor_id', vendedor_id)
    }
    if (status) query = query.eq('status', status)
    if (mes || ano) {
      const { inicio, fim } = intervaloMes(mes, ano)
      query = query.gte('data_geracao', inicio).lt('data_geracao', fim)
    }

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/comissoes/estimativa?vendedor_id= — preview usado no formulário de pedido
// (rota antes de /resumo não importa, paths distintos, mas fica junto por serem os
// dois endpoints "leves" de leitura)
router.get('/estimativa', async (req, res) => {
  try {
    const { vendedor_id } = req.query
    if (!vendedor_id) return res.status(400).json({ erro: 'vendedor_id é obrigatório' })
    if (req.user.role === 'vendedor' && req.user.id !== vendedor_id) {
      return res.status(403).json({ erro: 'Sem permissão' })
    }

    const estimativa = await calcularComissaoEstimada(vendedor_id)
    res.json(estimativa)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/comissoes/resumo?mes=&ano= — resumo por vendedor (meta, vendido, % atingido, comissão)
router.get('/resumo', async (req, res) => {
  try {
    const { mes, ano } = req.query
    const { inicio, fim } = intervaloMes(mes, ano)

    // Parte de usuarios (não de comissoes) pra vendedor sem nenhuma comissão no mês
    // ainda aparecer no resumo, com vendido R$0.
    const { data: vendedores, error: errVend } = await supabase
      .from('usuarios')
      .select('id, nome, meta_mensal')
      .eq('role', 'vendedor')
      .order('nome', { ascending: true })
    if (errVend) throw errVend

    const comissoesMes = await buscarTodasComissoesDoMes(inicio, fim)

    const resumo = vendedores.map(v => {
      const doVendedor = comissoesMes.filter(c => c.vendedor_id === v.id)
      const totalVendido = doVendedor.reduce((acc, c) => acc + Number(c.valor_base), 0)
      const totalComissao = doVendedor.reduce((acc, c) => acc + Number(c.valor_comissao), 0)
      const metaMensal = Number(v.meta_mensal) || 0
      const percentualAtingido = metaMensal > 0 ? (totalVendido / metaMensal) * 100 : 0

      return {
        vendedor_id: v.id,
        vendedor_nome: v.nome,
        meta_mensal: metaMensal,
        total_vendido: totalVendido,
        percentual_atingido: percentualAtingido,
        bateu_meta: metaMensal > 0 && totalVendido >= metaMensal,
        total_comissao: totalComissao,
      }
    })

    const resultado = req.user.role === 'vendedor'
      ? resumo.filter(r => r.vendedor_id === req.user.id)
      : resumo

    res.json(resultado)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/comissoes/:id/pagar — marca comissão como paga (só admin)
router.patch('/:id/pagar', adminOnly, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('comissoes')
      .update({
        status: 'paga',
        data_pagamento: new Date().toISOString(),
        pago_por_usuario_id: req.user.id,
        atualizado_em: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select(SELECT_COMISSAO)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Comissão não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
