import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'

const router = Router()

// GET /api/notas-entrada — listar notas de entrada (compras de fornecedor)
router.get('/', async (req, res) => {
  try {
    const { fornecedor, numero_nota, data_de, data_ate, page = 1, limit = 50 } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    let query = supabase
      .from('notas_entrada')
      .select('*, usuarios(id, nome)', { count: 'exact' })
      .order('data_entrada', { ascending: false })
      .range(offset, offset + Number(limit) - 1)

    if (fornecedor) query = query.ilike('fornecedor_nome', `%${fornecedor}%`)
    if (numero_nota) query = query.ilike('numero_nota', `%${numero_nota}%`)
    if (data_de) query = query.gte('data_entrada', data_de)
    if (data_ate) query = query.lte('data_entrada', data_ate)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/notas-entrada/:id — detalhe com itens
router.get('/:id', async (req, res) => {
  try {
    const { data: nota, error } = await supabase
      .from('notas_entrada')
      .select('*, usuarios(id, nome)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!nota) return res.status(404).json({ erro: 'Nota de entrada não encontrada' })

    const { data: itens, error: errItens } = await supabase
      .from('notas_entrada_itens')
      .select('*, produtos(id, nome, sku)')
      .eq('nota_entrada_id', req.params.id)

    if (errItens) throw errItens

    res.json({ ...nota, itens })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/notas-entrada — registrar nova nota de entrada (compra de fornecedor)
//
// Ao confirmar: cria o cabeçalho, os itens, uma movimentação de estoque tipo
// "entrada" (motivo "NE" — mesmo código usado nas notas de entrada migradas
// do ERP legado) por item, e opcionalmente uma conta a pagar em
// contas_financeiras. Tudo isso roda numa única transação via a função
// fn_criar_nota_entrada (Postgres), para não deixar estoque ou financeiro
// inconsistentes se algo falhar no meio.
router.post('/', async (req, res) => {
  try {
    const {
      numero_nota, serie, fornecedor_nome, fornecedor_cnpj,
      data_emissao, data_entrada, valor_total, forma_pagamento,
      gerar_conta_pagar, vencimento, observacoes, itens,
    } = req.body

    if (!numero_nota || !fornecedor_nome || !data_emissao || valor_total == null) {
      return res.status(400).json({
        erro: '"numero_nota", "fornecedor_nome", "data_emissao" e "valor_total" são obrigatórios',
      })
    }

    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: 'A nota de entrada precisa ter ao menos 1 item' })
    }

    for (const item of itens) {
      if (!item.produto_id || !item.quantidade || Number(item.quantidade) <= 0 || item.valor_unitario == null) {
        return res.status(400).json({
          erro: 'Cada item precisa de "produto_id", "quantidade" positiva e "valor_unitario"',
        })
      }
    }

    if (gerar_conta_pagar && !vencimento) {
      return res.status(400).json({ erro: 'Vencimento é obrigatório para gerar conta a pagar' })
    }

    const payload = {
      numero_nota, serie, fornecedor_nome, fornecedor_cnpj,
      data_emissao, data_entrada, valor_total: Number(valor_total), forma_pagamento,
      gerar_conta_pagar: !!gerar_conta_pagar, vencimento, observacoes,
      usuario_id: req.user?.id,
      itens: itens.map(i => ({
        produto_id: i.produto_id,
        quantidade: Number(i.quantidade),
        valor_unitario: Number(i.valor_unitario),
        atualizar_custo: i.atualizar_custo !== false,
      })),
    }

    const { data, error } = await supabase.rpc('fn_criar_nota_entrada', { p_payload: payload })
    if (error) throw error

    const { data: notaCompleta, error: errNota } = await supabase
      .from('notas_entrada')
      .select('*')
      .eq('id', data.id)
      .single()

    if (errNota) throw errNota

    res.status(201).json(notaCompleta)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
