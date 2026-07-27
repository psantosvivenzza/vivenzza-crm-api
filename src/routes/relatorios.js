import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { adminOnly } from '../middleware/auth.js'

const router = Router()

// Formas de pagamento (código SEFAZ) tratadas como À Vista na Seção A do DRE —
// aproximação: `nfe` não guarda condição de pagamento (parcela única no dia),
// só o método (forma_pagamento). Boleto/Outros caem em "A Prazo".
const FORMAS_A_VISTA = new Set(['01', '03', '04', '17'])

// Busca todas as linhas de uma query supabase paginando de 1000 em 1000 —
// o limite padrão do PostgREST já causou 2 bugs de dado incompleto nesta sessão
// (backfill de leads e mapa de telefones de clientes_erp), então toda query
// potencialmente > 1000 linhas neste arquivo passa por aqui.
async function buscarTudo(construirQuery) {
  const PAGE = 1000
  const linhas = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await construirQuery(offset, offset + PAGE - 1)
    if (error) throw error
    linhas.push(...data)
    if (data.length < PAGE) break
  }
  return linhas
}

const mesArray = () => Array.from({ length: 12 }, (_, i) => i + 1)

// GET /api/relatorios/dre?ano=2026&mes=7 (mês único) ou ?ano=2026 (12 meses lado a lado)
router.get('/dre', adminOnly, async (req, res) => {
  try {
    const ano = Number(req.query.ano)
    const mesFiltro = req.query.mes ? Number(req.query.mes) : null
    if (!ano) return res.status(400).json({ erro: '"ano" é obrigatório' })

    const inicioAno = `${ano}-01-01`
    const inicioProxAno = `${ano + 1}-01-01`

    const [notas, itens, contas] = await Promise.all([
      buscarTudo((from, to) =>
        supabase
          .from('nfe')
          .select('data_emissao, forma_pagamento, status, serie, valor_produtos, valor_icms, valor_pis, valor_cofins, valor_total')
          .gte('data_emissao', inicioAno)
          .lt('data_emissao', inicioProxAno)
          .range(from, to)
      ),
      buscarTudo((from, to) =>
        supabase
          .from('nfe_itens')
          .select('quantidade, produto_id, nfe!inner(data_emissao, status, serie)')
          .gte('nfe.data_emissao', inicioAno)
          .lt('nfe.data_emissao', inicioProxAno)
          .range(from, to)
      ),
      buscarTudo((from, to) =>
        supabase
          .from('contas_financeiras')
          .select('tipo, categoria_dre, valor, vencimento')
          .gte('vencimento', inicioAno)
          .lt('vencimento', inicioProxAno)
          .range(from, to)
      ),
    ])

    const { data: produtos, error: errProdutos } = await supabase.from('produtos').select('id, preco_custo')
    if (errProdutos) throw errProdutos
    const custoPorProduto = Object.fromEntries(produtos.map(p => [p.id, Number(p.preco_custo) || 0]))

    const secoesPorMes = mesArray().map(mes => calcularSecoesDoMes({ mes, notas, itens, contas, custoPorProduto }))

    if (mesFiltro) {
      const secoes = secoesPorMes[mesFiltro - 1]
      return res.json({ periodo: { ano, mes: mesFiltro }, secoes, gerado_em: new Date().toISOString() })
    }

    res.json({
      periodo: { ano },
      meses: mesArray().map(mes => ({ mes, secoes: secoesPorMes[mes - 1] })),
      gerado_em: new Date().toISOString(),
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

function calcularSecoesDoMes({ mes, notas, itens, contas, custoPorProduto }) {
  const doMes = (dataStr) => new Date(dataStr).getUTCMonth() + 1 === mes

  // Só entram na apuração fiscal notas série 1 (NF-e SEFAZ) realmente autorizadas —
  // nota interna (série 99) não tem validade fiscal e rascunho/rejeitada não são
  // vendas de fato ocorridas.
  const notasFiscaisDoMes = notas.filter(n => doMes(n.data_emissao) && n.serie === 1)
  const notasValidas = notasFiscaisDoMes.filter(n => n.status === 'autorizada')
  const notasCanceladas = notasFiscaisDoMes.filter(n => n.status === 'cancelada')

  const aVista = notasValidas.filter(n => FORMAS_A_VISTA.has(n.forma_pagamento)).reduce((s, n) => s + Number(n.valor_produtos || 0), 0)
  const aPrazo = notasValidas.filter(n => !FORMAS_A_VISTA.has(n.forma_pagamento)).reduce((s, n) => s + Number(n.valor_produtos || 0), 0)
  const receitaBruta = aVista + aPrazo

  const deducoes = notasCanceladas.reduce((s, n) => s + Number(n.valor_total || 0), 0)
  const impostos = notasValidas.reduce((s, n) => s + Number(n.valor_icms || 0) + Number(n.valor_pis || 0) + Number(n.valor_cofins || 0), 0)
  const receitaLiquida = receitaBruta - deducoes - impostos

  const custoDireto = itens
    .filter(i => doMes(i.nfe.data_emissao) && i.nfe.serie === 1 && i.nfe.status === 'autorizada')
    .reduce((s, i) => s + Number(i.quantidade || 0) * (custoPorProduto[i.produto_id] || 0), 0)
  const lucroBruto = receitaLiquida - custoDireto

  const contasDoMes = contas.filter(c => doMes(c.vencimento))
  const somaContas = (tipo, categorias) => contasDoMes
    .filter(c => c.tipo === tipo && categorias.includes(c.categoria_dre))
    .reduce((s, c) => s + Number(c.valor || 0), 0)

  const despesasOperacionais = somaContas('pagar', ['administrativa', 'pessoal'])
  const despesasFinanceiras = somaContas('pagar', ['financeira'])
  const receitasFinanceiras = somaContas('receber', ['financeira'])
  const lucroOperacional = lucroBruto - despesasOperacionais - despesasFinanceiras + receitasFinanceiras

  const retiradas = somaContas('pagar', ['retirada'])
  const lucroEfetivo = lucroOperacional - retiradas

  const pct = (v) => receitaBruta > 0 ? Number((v / receitaBruta * 100).toFixed(1)) : 0

  return [
    { codigo: 'A', label: 'Receita Bruta', valor: receitaBruta, percentual: pct(receitaBruta),
      sublinhas: [
        { label: 'À Vista', valor: aVista, percentual: pct(aVista) },
        { label: 'A Prazo', valor: aPrazo, percentual: pct(aPrazo) },
      ] },
    { codigo: 'B', label: 'Deduções', valor: deducoes, percentual: pct(deducoes) },
    { codigo: 'C', label: 'Impostos', valor: impostos, percentual: pct(impostos) },
    { codigo: 'D', label: 'Receita Operacional Líquida', valor: receitaLiquida, percentual: pct(receitaLiquida) },
    { codigo: 'E', label: 'Custo Direto Mercadorias', valor: custoDireto, percentual: pct(custoDireto) },
    { codigo: 'F', label: 'Lucro Bruto', valor: lucroBruto, percentual: pct(lucroBruto) },
    { codigo: 'G', label: 'Despesas Operacionais', valor: despesasOperacionais, percentual: pct(despesasOperacionais) },
    { codigo: 'H', label: 'Despesas Financeiras', valor: despesasFinanceiras, percentual: pct(despesasFinanceiras) },
    { codigo: 'I', label: 'Receitas Financeiras', valor: receitasFinanceiras, percentual: pct(receitasFinanceiras) },
    { codigo: 'J', label: 'Lucro Operacional', valor: lucroOperacional, percentual: pct(lucroOperacional) },
    { codigo: 'K', label: 'Retiradas de Sócios', valor: retiradas, percentual: pct(retiradas) },
    { codigo: 'L', label: 'Lucro Efetivo', valor: lucroEfetivo, percentual: pct(lucroEfetivo) },
  ]
}

router.get('/', adminOnly, async (req, res) => {
  try {
    const trintaDiasAtras = new Date()
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30)

    const [leadsRes, leadsRecentesRes] = await Promise.all([
      supabase.from('leads').select('responsavel_id, etapa, valor_negociacao, origem, usuarios(nome)').gte('created_at', trintaDiasAtras.toISOString()),
      supabase.from('leads').select('created_at').gte('created_at', trintaDiasAtras.toISOString()),
    ])

    if (leadsRes.error) throw leadsRes.error

    const leads = leadsRes.data || []

    // 1. Performance por vendedora
    const mapaVendedoras = {}
    for (const lead of leads) {
      const id = lead.responsavel_id || '__sem_responsavel__'
      const nome = lead.usuarios?.nome || 'Sem responsável'
      if (!mapaVendedoras[id]) {
        mapaVendedoras[id] = {
          nome,
          total: 0,
          etapas: { novo: 0, contato: 0, proposta: 0, negociacao: 0, fechado: 0, perdido: 0 },
          valor_negociacao: 0,
        }
      }
      mapaVendedoras[id].total++
      const etapa = lead.etapa || 'novo'
      mapaVendedoras[id].etapas[etapa] = (mapaVendedoras[id].etapas[etapa] || 0) + 1
      if (['contato', 'proposta', 'negociacao'].includes(etapa)) {
        mapaVendedoras[id].valor_negociacao += Number(lead.valor_negociacao) || 0
      }
    }

    const performance_vendedoras = Object.values(mapaVendedoras)
      .map((v) => ({
        ...v,
        taxa_conversao: v.total > 0 ? Number(((v.etapas.fechado || 0) / v.total) * 100).toFixed(1) : '0.0',
      }))
      .sort((a, b) => b.total - a.total)

    // 2. Leads por origem e por campanha (origens que começam com 'campanha_')
    const mapaOrigens = {}
    const mapaCampanhas = {}
    for (const lead of leads) {
      const origem = lead.origem || 'manual'
      mapaOrigens[origem] = (mapaOrigens[origem] || 0) + 1

      if (origem.startsWith('campanha_')) {
        if (!mapaCampanhas[origem]) {
          mapaCampanhas[origem] = {
            origem,
            total: 0,
            etapas: { novo: 0, contato: 0, proposta: 0, negociacao: 0, fechado: 0, perdido: 0 },
            valor_negociacao: 0,
          }
        }
        mapaCampanhas[origem].total++
        const etapa = lead.etapa || 'novo'
        mapaCampanhas[origem].etapas[etapa] = (mapaCampanhas[origem].etapas[etapa] || 0) + 1
        if (['contato', 'proposta', 'negociacao'].includes(etapa)) {
          mapaCampanhas[origem].valor_negociacao += Number(lead.valor_negociacao) || 0
        }
      }
    }

    const leads_por_origem = Object.entries(mapaOrigens)
      .map(([origem, total]) => ({ origem, total }))
      .sort((a, b) => b.total - a.total)

    const leads_por_campanha = Object.values(mapaCampanhas)
      .map((c) => ({
        ...c,
        taxa_conversao: c.total > 0 ? Number(((c.etapas.fechado || 0) / c.total) * 100).toFixed(1) : '0.0',
      }))
      .sort((a, b) => b.total - a.total)

    // 3. Evolução temporal — últimos 30 dias (inclui dias sem leads)
    const porDia = {}
    for (const lead of leadsRecentesRes.data || []) {
      const dia = lead.created_at?.slice(0, 10)
      if (dia) porDia[dia] = (porDia[dia] || 0) + 1
    }

    const evolucao_temporal = []
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const dia = d.toISOString().slice(0, 10)
      evolucao_temporal.push({ dia, total: porDia[dia] || 0 })
    }

    res.json({ performance_vendedoras, leads_por_campanha, leads_por_origem, evolucao_temporal, gerado_em: new Date().toISOString() })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
