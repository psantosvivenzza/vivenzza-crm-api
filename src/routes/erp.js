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

// PUT /api/admin/erp/clientes/:id — edição de cadastro
router.put('/clientes/:id', async (req, res) => {
  try {
    const {
      razao_social, nome_fantasia, cnpj_cpf, ie,
      telefone, celular, email,
      logradouro, numero, complemento, bairro, cidade, estado, cep, pais,
      observacoes, ativo,
    } = req.body

    if (!razao_social) return res.status(400).json({ erro: 'razao_social é obrigatório' })

    // contatos/endereco são JSONB — o form manda o estado completo, então
    // reconstrói os dois objetos inteiros em vez de fazer merge parcial.
    const contatos = [
      telefone && { tipo: 'telefone', valor: telefone },
      celular && { tipo: 'celular', valor: celular },
      email && { tipo: 'email', valor: email },
    ].filter(Boolean)

    const endereco = {
      logradouro: logradouro || null,
      numero: numero || null,
      complemento: complemento || null,
      bairro: bairro || null,
      cidade: cidade || null,
      estado: estado || null,
      cep: cep || null,
      pais: pais || null,
    }

    const { data, error } = await supabase
      .from('clientes_erp')
      .update({ razao_social, nome_fantasia, cnpj_cpf, ie, contatos, endereco, observacoes, ativo })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Cliente não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/notas-legado — histórico unificado de duas fontes legadas:
// vendas_legado (série 99 — notas internas, migração validada) e nfe.serie=1
// (série "E" do NetVision — NF-e SEFAZ reais, legacy_id termina em "-E"). As
// demais séries em `nfe` (0,2,3,5,10,33,55,890) são artefato de importação sem
// cliente real vinculado e ficam de fora — ver notas_legado_unificado_view.sql.
router.get('/notas-legado', async (req, res) => {
  try {
    const { q, data_inicio, data_fim, status, serie, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    let query = supabase
      .from('notas_legado_unificado')
      .select('id, origem, numero, serie, serie_label, data_emissao, valor_total, status, em_revisao, cliente_nome, cliente_cnpj', { count: 'exact' })
      .order('data_emissao', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (data_inicio) query = query.gte('data_emissao', data_inicio)
    if (data_fim) query = query.lte('data_emissao', data_fim)
    if (status) query = query.eq('status', status)
    // Trata qualquer valor "vazio" (string vazia, 'todas', 'null', 'undefined') como
    // "sem filtro" — mesma defesa já usada nos outros filtros de série do sistema.
    const serieValida = serie && !['todas', 'null', 'undefined'].includes(String(serie).toLowerCase())
    if (serieValida) query = query.eq('serie', serie)
    if (q) query = query.ilike('numero', `%${q}%`)

    const { data, error, count } = await query
    if (error) throw error
    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/admin/erp/notas-legado/:id — detalhe normalizado, funciona pras duas
// origens (tenta vendas_legado primeiro, depois nfe serie=1) sem o frontend
// precisar saber de qual tabela veio.
router.get('/notas-legado/:id', async (req, res) => {
  try {
    const { data: viaVendas, error: errV } = await supabase
      .from('vendas_legado')
      .select('*, clientes_erp(razao_social, cnpj_cpf, ie, endereco)')
      .eq('id', req.params.id)
      .maybeSingle()
    if (errV) throw errV

    if (viaVendas) {
      // itens é jsonb com chaves compactas (c/q/u/vd/vt/vu) — sem nome de produto,
      // só o código legado (limitação da fonte, não do backend).
      const itens = (viaVendas.itens || []).map(it => ({
        codigo: it.c,
        descricao: it.c,
        ncm: null,
        quantidade: it.q,
        valor_unitario: it.vu,
        valor_desconto: it.vd,
        valor_total: it.vt,
      }))
      return res.json({
        origem: 'vendas_legado',
        serie: '99',
        serie_label: 'Interna',
        numero_nf: viaVendas.numero_nf,
        modelo: viaVendas.modelo,
        data_emissao: viaVendas.data_emissao,
        natureza_operacao: viaVendas.natureza_operacao,
        status: viaVendas.status,
        em_revisao: viaVendas.em_revisao,
        valor_produtos: viaVendas.valor_produtos,
        valor_desconto: viaVendas.valor_desconto,
        valor_total: viaVendas.valor_total,
        clientes_erp: viaVendas.clientes_erp,
        itens,
      })
    }

    const { data: viaNfe, error: errN } = await supabase
      .from('nfe')
      .select('*, nfe_itens(*)')
      .eq('id', req.params.id)
      .eq('serie', 1)
      .maybeSingle()
    if (errN) throw errN
    if (!viaNfe) return res.status(404).json({ erro: 'Nota não encontrada' })

    const itens = (viaNfe.nfe_itens || [])
      .sort((a, b) => (a.numero_item || 0) - (b.numero_item || 0))
      .map(it => ({
        codigo: it.codigo,
        descricao: it.descricao,
        ncm: it.ncm,
        quantidade: it.quantidade,
        valor_unitario: it.valor_unitario,
        valor_desconto: it.valor_desconto,
        valor_total: it.valor_total,
      }))

    res.json({
      origem: 'nfe',
      serie: 'E',
      serie_label: 'NF-e SEFAZ',
      numero_nf: String(viaNfe.numero),
      modelo: '55',
      data_emissao: viaNfe.data_emissao,
      natureza_operacao: viaNfe.natureza_operacao,
      status: viaNfe.status,
      em_revisao: false,
      valor_produtos: viaNfe.valor_produtos,
      valor_desconto: viaNfe.valor_desconto,
      valor_total: viaNfe.valor_total,
      clientes_erp: { razao_social: viaNfe.dest_nome, cnpj_cpf: viaNfe.dest_cnpj_cpf, ie: viaNfe.dest_ie, endereco: null },
      itens,
    })
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
