import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { validarCnpj, normalizarCnpj } from '../lib/cnpj.js'

const router = Router()

// GET /api/fornecedores — listar/buscar (por nome ou CNPJ)
router.get('/', async (req, res) => {
  try {
    const { busca, cnpj, ativo, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('fornecedores')
      .select('*', { count: 'exact' })
      .order('razao_social', { ascending: true })
      .range(offset, offset + Number(limit) - 1)

    if (busca) query = query.or(`razao_social.ilike.%${busca}%,nome_fantasia.ilike.%${busca}%`)
    if (cnpj) query = query.eq('cnpj', normalizarCnpj(cnpj))
    if (ativo !== undefined) query = query.eq('ativo', ativo === 'true')

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/fornecedores/buscar-por-cnpj/:cnpj — usado pelo fluxo de importação de XML
// pra checar se o fornecedor do XML já existe antes de perguntar ao usuário
// se quer criar um novo (nunca cria silenciosamente).
router.get('/buscar-por-cnpj/:cnpj', async (req, res) => {
  try {
    const cnpjNormalizado = normalizarCnpj(req.params.cnpj)
    const { data, error } = await supabase
      .from('fornecedores')
      .select('*')
      .eq('cnpj', cnpjNormalizado)
      .maybeSingle()

    if (error) throw error
    res.json({ encontrado: !!data, fornecedor: data || null })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/fornecedores/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('fornecedores')
      .select('*')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Fornecedor não encontrado' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/fornecedores — criação SEMPRE explícita (manual pelo usuário, ou
// disparada pela tela de conferência do XML depois que o usuário confirmou
// "sim, criar este fornecedor" — nunca automática/silenciosa).
router.post('/', async (req, res) => {
  try {
    const { cnpj, razao_social, nome_fantasia, ie, endereco, contatos, origem } = req.body

    if (!cnpj || !razao_social) {
      return res.status(400).json({ erro: '"cnpj" e "razao_social" são obrigatórios' })
    }

    const cnpjNormalizado = normalizarCnpj(cnpj)
    if (!validarCnpj(cnpjNormalizado)) {
      return res.status(400).json({ erro: `CNPJ inválido: ${cnpj}` })
    }

    const { data: existente } = await supabase
      .from('fornecedores')
      .select('id')
      .eq('cnpj', cnpjNormalizado)
      .maybeSingle()

    if (existente) {
      return res.status(409).json({ erro: 'Já existe um fornecedor cadastrado com este CNPJ', fornecedor_id: existente.id })
    }

    const { data, error } = await supabase
      .from('fornecedores')
      .insert({
        cnpj: cnpjNormalizado,
        razao_social,
        nome_fantasia: nome_fantasia || razao_social,
        ie: ie || null,
        endereco: endereco || {},
        contatos: contatos || [],
        origem: origem === 'xml_nfe' ? 'xml_nfe' : 'manual',
        criado_por: req.user?.id,
      })
      .select()
      .single()

    if (error) throw error
    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/fornecedores/:id
router.patch('/:id', async (req, res) => {
  try {
    const { razao_social, nome_fantasia, ie, endereco, contatos, ativo } = req.body
    const campos = { atualizado_em: new Date().toISOString() }
    if (razao_social !== undefined) campos.razao_social = razao_social
    if (nome_fantasia !== undefined) campos.nome_fantasia = nome_fantasia
    if (ie !== undefined) campos.ie = ie
    if (endereco !== undefined) campos.endereco = endereco
    if (contatos !== undefined) campos.contatos = contatos
    if (ativo !== undefined) campos.ativo = ativo

    const { data, error } = await supabase
      .from('fornecedores')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
