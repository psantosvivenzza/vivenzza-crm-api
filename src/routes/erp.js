import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/admin/erp/clientes
router.get('/clientes', async (req, res) => {
  try {
    const { q, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    let query = supabase
      .from('clientes_erp')
      .select('id, tipo, razao_social, nome_fantasia, cnpj_cpf, ie, data_cadastro, ativo, em_revisao', { count: 'exact' })
      .order('razao_social')
      .range(offset, offset + Number(limit) - 1)
    if (q) query = query.or(`razao_social.ilike.%${q}%,nome_fantasia.ilike.%${q}%,cnpj_cpf.ilike.%${q}%`)
    const { data, error, count } = await query
    if (error) throw error
    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/clientes/:id — detalhe + histórico de vendas
router.get('/clientes/:id', async (req, res) => {
  try {
    const [clienteRes, vendasRes] = await Promise.all([
      supabase.from('clientes_erp').select('*').eq('id', req.params.id).single(),
      supabase
        .from('vendas_legado')
        .select('id, numero_nf, serie, data_emissao, valor_total, status')
        .eq('cliente_erp_id', req.params.id)
        .order('data_emissao', { ascending: false })
        .limit(30),
    ])
    if (clienteRes.error) throw clienteRes.error
    res.json({ cliente: clienteRes.data, vendas: vendasRes.data || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/notas — listar vendas_legado (NFs modelo 01/55)
router.get('/notas', async (req, res) => {
  try {
    const { q, data_inicio, data_fim, status, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    let query = supabase
      .from('vendas_legado')
      .select('id, numero_nf, serie, modelo, data_emissao, natureza_operacao, valor_total, valor_produtos, status, em_revisao, clientes_erp(razao_social, cnpj_cpf)', { count: 'exact' })
      .order('data_emissao', { ascending: false })
      .range(offset, offset + Number(limit) - 1)
    if (data_inicio) query = query.gte('data_emissao', data_inicio)
    if (data_fim) query = query.lte('data_emissao', data_fim)
    if (status) query = query.eq('status', status)
    if (q) query = query.ilike('numero_nf', `%${q}%`)
    const { data, error, count } = await query
    if (error) throw error
    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/notas/:id — detalhe com itens (JSONB)
router.get('/notas/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('vendas_legado')
      .select('*, clientes_erp(razao_social, cnpj_cpf, ie, endereco)')
      .eq('id', req.params.id)
      .single()
    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/financeiro — contas + totais
router.get('/financeiro', async (req, res) => {
  try {
    const { tipo, status, em_revisao, page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    let query = supabase
      .from('contas_financeiras')
      .select('*', { count: 'exact' })
      .order('vencimento')
      .range(offset, offset + Number(limit) - 1)
    if (tipo) query = query.eq('tipo', tipo)
    if (status) query = query.eq('status', status)
    if (em_revisao === 'true') query = query.eq('em_revisao', true)

    const [listRes, allRes] = await Promise.all([
      query,
      supabase.from('contas_financeiras').select('tipo, status, valor, vencimento, em_revisao'),
    ])
    if (listRes.error) throw listRes.error

    const contas = allRes.data || []
    const isAberta = s => ['aberta', 'aberto'].includes(s)
    const isVencida = s => ['vencida', 'vencido'].includes(s)
    const totais = {
      a_receber: contas.filter(c => c.tipo === 'receber' && isAberta(c.status)).reduce((s, c) => s + Number(c.valor || 0), 0),
      a_pagar:   contas.filter(c => c.tipo === 'pagar'   && isAberta(c.status)).reduce((s, c) => s + Number(c.valor || 0), 0),
      vencidos:  contas.filter(c => isVencida(c.status)).reduce((s, c) => s + Number(c.valor || 0), 0),
      em_revisao: contas.filter(c => c.em_revisao).length,
    }
    res.json({ data: listRes.data, total: listRes.count, page: Number(page), limit: Number(limit), totais })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/estoque — saldos com info do produto
router.get('/estoque', async (req, res) => {
  try {
    const { page = 1, limit = 100 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    const { data, error, count } = await supabase
      .from('estoque')
      .select('*, produtos(id, nome, sku, unidade, ncm, legacy_id)', { count: 'exact' })
      .order('quantidade')
      .range(offset, offset + Number(limit) - 1)
    if (error) throw error
    res.json({ data: data || [], total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
