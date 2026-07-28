import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

function diasAtrasoDe(vencimento) {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const umDia = 24 * 60 * 60 * 1000
  return Math.floor((new Date(hojeBrt) - new Date(vencimento)) / umDia)
}

// Bucket de aging a partir de vencimento vs hoje — nunca confia em `status`
// (todo título legado foi importado como 'aberta' independente do atraso real).
function bucketDe(diasAtraso) {
  if (diasAtraso <= 0) return 'a_vencer'
  if (diasAtraso <= 30) return 'd1_30'
  if (diasAtraso <= 60) return 'd31_60'
  if (diasAtraso <= 90) return 'd61_90'
  return 'd90_mais'
}

const ORDEM_SCORE = { a_vencer: 0, d1_30: 1, d31_60: 2, d61_90: 3, d90_mais: 3 } // 61+ = vermelho
const SCORE_POR_ORDEM = ['verde', 'amarelo', 'laranja', 'vermelho']

async function buscarContasAbertas({ vendedor_id }) {
  let query = supabase
    .from('contas_financeiras')
    .select('id, pessoa_nome, valor, vencimento, telefone_cobranca, vendedor_id, pedido_id')
    .eq('tipo', 'receber')
    .in('status', ['aberta', 'vencida'])

  if (vendedor_id) query = query.eq('vendedor_id', vendedor_id)

  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

// GET /api/financeiro/aging/resumo — os 6 cards
router.get('/resumo', async (req, res) => {
  try {
    const contas = await buscarContasAbertas({ vendedor_id: req.query.vendedor_id })

    const resumo = { total: 0, a_vencer: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_mais: 0 }
    for (const c of contas) {
      const bucket = bucketDe(diasAtrasoDe(c.vencimento))
      const valor = Number(c.valor || 0)
      resumo.total += valor
      resumo[bucket] += valor
    }

    res.json(resumo)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/financeiro/aging — lista agrupada por cliente (pessoa_nome)
router.get('/', async (req, res) => {
  try {
    const { vendedor_id, faixa, valor_minimo } = req.query
    const contas = await buscarContasAbertas({ vendedor_id })

    const porCliente = new Map()
    for (const c of contas) {
      const diasAtraso = diasAtrasoDe(c.vencimento)
      const bucket = bucketDe(diasAtraso)
      const valor = Number(c.valor || 0)

      if (!porCliente.has(c.pessoa_nome)) {
        porCliente.set(c.pessoa_nome, {
          pessoa_nome: c.pessoa_nome,
          total_devido: 0,
          a_vencer: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_mais: 0,
          telefone_cobranca: null,
          vendedor_id: null,
          pior_ordem_score: 0,
        })
      }
      const cliente = porCliente.get(c.pessoa_nome)
      cliente.total_devido += valor
      cliente[bucket] += valor
      cliente.pior_ordem_score = Math.max(cliente.pior_ordem_score, ORDEM_SCORE[bucket])
      if (!cliente.telefone_cobranca && c.telefone_cobranca) cliente.telefone_cobranca = c.telefone_cobranca
      if (!cliente.vendedor_id && c.vendedor_id) cliente.vendedor_id = c.vendedor_id
    }

    let linhas = [...porCliente.values()].map((c) => ({
      ...c,
      score: SCORE_POR_ORDEM[c.pior_ordem_score],
    }))

    if (faixa) linhas = linhas.filter((c) => Number(c[faixa] || 0) > 0)
    if (valor_minimo) linhas = linhas.filter((c) => c.total_devido >= Number(valor_minimo))

    linhas.sort((a, b) => b.total_devido - a.total_devido)

    res.json({ data: linhas, total: linhas.length })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/financeiro/aging/telefone — atualiza telefone_cobranca em todos os
// títulos abertos de um cliente de uma vez (edição é a nível de cliente, não de título).
router.patch('/telefone', async (req, res) => {
  try {
    const { pessoa_nome, telefone } = req.body
    if (!pessoa_nome || !telefone) {
      return res.status(400).json({ erro: 'pessoa_nome e telefone são obrigatórios' })
    }

    const { error, count } = await supabase
      .from('contas_financeiras')
      .update({ telefone_cobranca: telefone }, { count: 'exact' })
      .eq('pessoa_nome', pessoa_nome)
      .eq('tipo', 'receber')
      .in('status', ['aberta', 'vencida'])

    if (error) throw error

    res.json({ pessoa_nome, telefone, titulos_atualizados: count })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
