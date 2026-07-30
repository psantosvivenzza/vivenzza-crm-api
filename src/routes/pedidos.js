import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { calcularComissaoEstimada } from '../lib/comissoes.js'
import { executarSincronizacaoPedidos } from '../jobs/sync-pedidos-legado.js'

const router = Router()

// Alinhado ao CHECK real do banco (pedidos_status_check) — o array anterior
// ('em_producao', 'enviado') não existe no CHECK e travava com 500 se usado;
// 'faturado' existe no CHECK e faltava aqui, travando toda tentativa de mover
// um pedido faturado.
const STATUS_VALIDOS = ['rascunho', 'confirmado', 'faturado', 'entregue', 'cancelado']

// Campos que o endpoint de edição genérica (PUT /:id) pode alterar. "status" fica
// de fora de propósito — transições de status continuam só por PUT /:id/status,
// que tem lógica própria (gera parcelas, comissão estimada).
const CAMPOS_EDITAVEIS_HEADER = [
  'condicao_pagamento', 'forma_pagamento', 'lista_preco', 'observacoes',
  'vendedor_id', 'vendedor_nome', 'tipo_frete', 'peso_bruto', 'peso_liquido', 'qtde_volumes',
]
const CAMPOS_SENSIVEIS = ['cliente_erp_id', 'desconto', 'valor_frete'] // + itens — bloqueados se faturado/NFe autorizada

// Select "leve" pra listagem — a tabela da lista só usa pedido_itens.length (não
// precisa de produtos aninhado); count:'exact' com o embed pesado original já dava
// timeout em produção com 9k+ pedidos / 55k+ itens, mesmo antes destas mudanças.
// O detalhe (GET /:id) usa o select completo abaixo.
// clientes_erp ao lado de leads: pedido novo usa cliente_erp_id, pedido antigo (migrado
// do legado) só tem lead_id — os dois embeds convivem, cada pedido só preenche um.
const SELECT_PEDIDO_LISTA = '*, leads(id, nome, empresa), clientes_erp(id, legacy_id, razao_social, nome_fantasia, cnpj_cpf), pedido_itens(id)'
const SELECT_PEDIDO_DETALHE = '*, leads(id, nome, empresa), clientes_erp(id, legacy_id, razao_social, nome_fantasia, cnpj_cpf, ie, endereco, contatos), usuarios!pedidos_representante_id_fkey(id, nome), pedido_itens(*, produtos(id, nome, sku, preco_b2c, preco_b2b, ncm, cst, cfop_padrao, unidade)), contas_financeiras(*)'

// Resolve o preço unitário do produto de acordo com a lista de preço do pedido.
// 'b2c'/'b2b'/'distribuidor' são as 3 colunas fixas; qualquer outro valor busca
// em produtos.extra_precos (as outras 10 listas migradas do legado).
function resolverPreco(produto, listaPreco) {
  if (listaPreco === 'b2c') return produto.preco_b2c ?? produto.preco_b2b ?? 0
  if (listaPreco === 'b2b') return produto.preco_b2b ?? produto.preco_b2c ?? 0
  if (listaPreco === 'distribuidor') return produto.preco_distribuidor ?? produto.preco_b2c ?? 0
  if (listaPreco && produto.extra_precos?.[listaPreco] != null) return produto.extra_precos[listaPreco]
  return produto.preco_b2c ?? produto.preco_b2b ?? 0
}

// Converte a condição de pagamento ("30/60/90", "a_vista", ...) na lista de dias
// de cada parcela. Formato não reconhecido cai em 1 parcela à vista — não trava a confirmação.
function gerarDiasParcelas(condicao) {
  if (!condicao || condicao === 'a_vista') return [0]
  if (/^\d+(\/\d+)*$/.test(condicao)) return condicao.split('/').map(Number)
  return [0]
}

const ORDENACOES = {
  recentes: { coluna: 'criado_em', ascending: false },
  atualizacao: { coluna: 'atualizado_em', ascending: false },
  valor: { coluna: 'total', ascending: false },
}

// GET /api/pedidos — listar
router.get('/', async (req, res) => {
  try {
    const {
      status, lead_id, page = 1, limit = 50,
      periodo_de, periodo_ate, cliente_erp_id, vendedor_id, sistema_origem,
      sem_vinculo, com_erro, com_conflito, importados_hoje, ordenar,
    } = req.query
    const offset = (Number(page) - 1) * Number(limit)

    // count:'planned' (estimativa via estatísticas do Postgres) em vez de 'exact' —
    // a lista não usa o total pra nada hoje, e o exato exigia escanear/contar o
    // join inteiro (9k+ pedidos x 55k+ itens) a cada request.
    let query = supabase
      .from('pedidos')
      .select(SELECT_PEDIDO_LISTA, { count: 'planned' })

    const ordenacao = ORDENACOES[ordenar] || ORDENACOES.recentes
    query = query.order(ordenacao.coluna, { ascending: ordenacao.ascending }).range(offset, offset + Number(limit) - 1)

    if (status) query = query.eq('status', status)
    if (lead_id) query = query.eq('lead_id', lead_id)
    if (cliente_erp_id) query = query.eq('cliente_erp_id', cliente_erp_id)
    if (sistema_origem) query = query.eq('sistema_origem', sistema_origem)
    if (periodo_de) query = query.gte('criado_em', periodo_de)
    if (periodo_ate) query = query.lte('criado_em', periodo_ate)
    if (sem_vinculo === 'true') query = query.eq('precisa_vinculo_cliente', true)
    if (com_erro === 'true') query = query.not('erro_sincronizacao', 'is', null)
    if (com_conflito === 'true') query = query.eq('conflito_sincronizacao', true)
    if (importados_hoje === 'true') query = query.gte('sincronizado_em', new Date().toISOString().split('T')[0])

    // Vendedor só vê os pedidos atribuídos a ele; admin pode filtrar por qualquer vendedor.
    if (req.user.role === 'vendedor') query = query.eq('vendedor_id', req.user.id)
    else if (vendedor_id) query = query.eq('vendedor_id', vendedor_id)

    const { data, error, count } = await query
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit) })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/pedidos/resumo — contagens por status + valor total, sem depender
// da página carregada no frontend (era a causa do card "Confirmados" zerado:
// a tela calculava isso só sobre os 200 pedidos mais recentes em memória).
// Registrado ANTES de "/:id" de propósito — "/:id" é um catch-all de um
// segmento e capturaria "/resumo" como se fosse um id se viesse primeiro.
router.get('/resumo', async (req, res) => {
  try {
    const scopoVendedor = req.user.role === 'vendedor' ? req.user.id : null

    const contarStatus = async (status) => {
      let q = supabase.from('pedidos').select('id', { count: 'exact', head: true }).eq('status', status)
      if (scopoVendedor) q = q.eq('vendedor_id', scopoVendedor)
      const { count, error } = await q
      if (error) throw error
      return count || 0
    }

    const [rascunho, confirmado, faturado, entregue, cancelado] = await Promise.all(STATUS_VALIDOS.map(contarStatus))

    // Soma o valor dos pedidos "ativos" (não rascunho nem cancelado) — paginado
    // pra não cair no truncamento silencioso de 1000 linhas do PostgREST.
    let valorTotal = 0
    const PAGE = 1000
    for (let offset = 0; ; offset += PAGE) {
      let q = supabase.from('pedidos').select('total').not('status', 'in', '(cancelado,rascunho)').range(offset, offset + PAGE - 1)
      if (scopoVendedor) q = q.eq('vendedor_id', scopoVendedor)
      const { data, error } = await q
      if (error) throw error
      for (const row of data) valorTotal += Number(row.total) || 0
      if (data.length < PAGE) break
    }

    res.json({
      total_pedidos: rascunho + confirmado + faturado + entregue + cancelado,
      por_status: { rascunho, confirmado, faturado, entregue, cancelado },
      valor_total: Math.round(valorTotal * 100) / 100,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/pedidos/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('pedidos')
      .select(SELECT_PEDIDO_DETALHE)
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Pedido não encontrado' })
    if (req.user.role === 'vendedor' && data.vendedor_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para acessar este pedido' })
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/pedidos/:id/historico — auditoria de edições
router.get('/:id/historico', async (req, res) => {
  try {
    const { data: pedido, error: erroPedido } = await supabase
      .from('pedidos').select('vendedor_id').eq('id', req.params.id).single()
    if (erroPedido) throw erroPedido
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' })
    if (req.user.role === 'vendedor' && pedido.vendedor_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para acessar este pedido' })
    }

    const { data, error } = await supabase
      .from('pedido_historico')
      .select('*, usuarios(id, nome)')
      .eq('pedido_id', req.params.id)
      .order('criado_em', { ascending: false })
    if (error) throw error

    res.json({ data: data || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/pedidos/sincronizacoes — histórico de sincronizações (admin)
router.get('/sincronizacoes/log', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas administradores podem ver o log de sincronização' })

    const { data, error } = await supabase
      .from('sincronizacoes_pedidos')
      .select('*, sincronizacao_pedidos_erros(id, pedido_externo_id, mensagem)')
      .order('iniciado_em', { ascending: false })
      .limit(20)
    if (error) throw error

    res.json({ data: data || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/pedidos/sincronizar — dispara a sincronização com o legado (admin)
router.post('/sincronizar', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas administradores podem sincronizar' })

    const resultado = await executarSincronizacaoPedidos({ usuarioId: req.user.id })
    res.json(resultado)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/pedidos/:id/vincular-cliente — resolve cliente ausente/ambíguo (admin)
router.post('/:id/vincular-cliente', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas administradores podem vincular cliente' })

    const { cliente_erp_id } = req.body
    if (!cliente_erp_id) return res.status(400).json({ erro: '"cliente_erp_id" é obrigatório' })

    const { data: pedido, error: erroBusca } = await supabase
      .from('pedidos').select('id, cliente_erp_id').eq('id', req.params.id).single()
    if (erroBusca) throw erroBusca
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' })

    const { data, error } = await supabase
      .from('pedidos')
      .update({ cliente_erp_id, precisa_vinculo_cliente: false, atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id)
      .select(SELECT_PEDIDO_DETALHE)
      .single()
    if (error) throw error

    await supabase.from('pedido_historico').insert({
      pedido_id: req.params.id,
      campo: 'cliente_erp_id',
      valor_anterior: pedido.cliente_erp_id,
      valor_novo: cliente_erp_id,
      usuario_id: req.user.id,
      origem: 'local',
    })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/pedidos/:id/resolver-conflito — decide entre a edição local e o
// dado vindo do legado quando a sincronização sinalizou conflito (admin).
router.post('/:id/resolver-conflito', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas administradores podem resolver conflitos de sincronização' })

    const { acao } = req.body
    if (!['manter_local', 'usar_origem'].includes(acao)) {
      return res.status(400).json({ erro: '"acao" deve ser "manter_local" ou "usar_origem"' })
    }

    const { data: pedido, error: erroBusca } = await supabase
      .from('pedidos').select('id, conflito_sincronizacao').eq('id', req.params.id).single()
    if (erroBusca) throw erroBusca
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' })
    if (!pedido.conflito_sincronizacao) return res.status(400).json({ erro: 'Este pedido não está com conflito de sincronização' })

    const camposUpdate = acao === 'manter_local'
      // Mantém os dados locais como estão — só encerra o alerta. Os campos
      // continuam protegidos (campos_com_override_local) contra a próxima sincronização.
      ? { conflito_sincronizacao: false }
      // Libera os campos pra próxima sincronização sobrescrever com o dado do
      // legado — não reaplica agora, só remove a proteção; o próximo ciclo do
      // job (cron a cada 30min, ou "Sincronizar agora") traz o valor de origem.
      : { conflito_sincronizacao: false, campos_com_override_local: [], atualizado_localmente_em: null, atualizado_localmente_por_usuario_id: null }

    const { data, error } = await supabase
      .from('pedidos').update(camposUpdate).eq('id', req.params.id).select(SELECT_PEDIDO_DETALHE).single()
    if (error) throw error

    await supabase.from('pedido_historico').insert({
      pedido_id: req.params.id, campo: 'conflito_sincronizacao', origem: 'local', usuario_id: req.user.id,
      valor_anterior: 'true', valor_novo: `resolvido:${acao}`,
    })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/pedidos/:id/duplicar — cria um novo pedido (rascunho) a partir de um existente
router.post('/:id/duplicar', async (req, res) => {
  try {
    const { data: original, error: erroBusca } = await supabase
      .from('pedidos')
      .select('*, pedido_itens(produto_id, quantidade, preco_unitario)')
      .eq('id', req.params.id)
      .single()
    if (erroBusca) throw erroBusca
    if (!original) return res.status(404).json({ erro: 'Pedido não encontrado' })
    if (req.user.role === 'vendedor' && original.vendedor_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para duplicar este pedido' })
    }

    const { data: novoPedido, error: errIns } = await supabase
      .from('pedidos')
      .insert({
        cliente_erp_id: original.cliente_erp_id,
        lead_id: original.lead_id,
        usuario_id: req.user.id,
        total: original.total,
        desconto: original.desconto,
        observacoes: original.observacoes,
        status: 'rascunho',
        condicao_pagamento: original.condicao_pagamento,
        forma_pagamento: original.forma_pagamento,
        lista_preco: original.lista_preco,
        vendedor_id: original.vendedor_id,
        vendedor_nome: original.vendedor_nome,
        valor_frete: original.valor_frete,
        tipo_frete: original.tipo_frete,
        peso_bruto: original.peso_bruto,
        peso_liquido: original.peso_liquido,
        qtde_volumes: original.qtde_volumes,
        sistema_origem: 'manual',
      })
      .select()
      .single()
    if (errIns) throw errIns

    if (original.pedido_itens?.length > 0) {
      const { error: errItens } = await supabase.from('pedido_itens').insert(
        original.pedido_itens.map(i => ({ produto_id: i.produto_id, quantidade: i.quantidade, preco_unitario: i.preco_unitario, pedido_id: novoPedido.id }))
      )
      if (errItens) throw errItens
    }

    const { data: pedidoCompleto, error: erroCompleto } = await supabase
      .from('pedidos').select(SELECT_PEDIDO_DETALHE).eq('id', novoPedido.id).single()
    if (erroCompleto) throw erroCompleto

    res.status(201).json(pedidoCompleto)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/pedidos/:id — edição de cabeçalho/itens/valores
router.put('/:id', async (req, res) => {
  try {
    const { data: pedido, error: erroBusca } = await supabase
      .from('pedidos').select('*, pedido_itens(*)').eq('id', req.params.id).single()
    if (erroBusca) throw erroBusca
    if (!pedido) return res.status(404).json({ erro: 'Pedido não encontrado' })
    if (req.user.role === 'vendedor' && pedido.vendedor_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para editar este pedido' })
    }
    if (pedido.status === 'cancelado') {
      return res.status(400).json({ erro: 'Pedido cancelado não pode ser editado' })
    }

    const { itens, ...camposBody } = req.body

    // NF-e autorizada ou pedido já faturado no legado: itens, valores e cliente
    // já refletem uma operação fiscal concluída — travados. Campos "soft" (forma
    // de pagamento, observações etc.) continuam editáveis.
    const bloqueiaItensValoresCliente = pedido.status_fiscal === 'autorizado' || pedido.status === 'faturado'
    const tentouAlterarBloqueado = itens !== undefined || CAMPOS_SENSIVEIS.some(c => camposBody[c] !== undefined)
    if (bloqueiaItensValoresCliente && tentouAlterarBloqueado) {
      return res.status(400).json({ erro: 'Pedido faturado ou com NF-e autorizada: itens, valores e cliente não podem ser alterados' })
    }

    if (Array.isArray(itens)) {
      for (const item of itens) {
        if (!item.quantidade || Number(item.quantidade) <= 0) {
          return res.status(400).json({ erro: 'Quantidade do item deve ser maior que zero' })
        }
      }
    }

    let itensPreparados = null
    let subtotal = null
    if (Array.isArray(itens) && itens.length > 0) {
      const ids = itens.map(i => i.produto_id)
      const { data: produtos, error: errProd } = await supabase
        .from('produtos')
        .select('id, preco_b2c, preco_b2b, preco_distribuidor, extra_precos')
        .in('id', ids)
      if (errProd) throw errProd

      const produtoMap = Object.fromEntries(produtos.map(p => [p.id, p]))
      const listaPreco = camposBody.lista_preco ?? pedido.lista_preco
      subtotal = 0
      itensPreparados = itens.map(item => {
        const produto = produtoMap[item.produto_id] || {}
        const preco = item.preco_unitario ?? resolverPreco(produto, listaPreco)
        const quantidade = Number(item.quantidade)
        subtotal += preco * quantidade
        return { produto_id: item.produto_id, quantidade, preco_unitario: preco }
      })
    }

    const desconto = camposBody.desconto !== undefined ? Number(camposBody.desconto) : Number(pedido.desconto || 0)
    const valorFrete = camposBody.valor_frete !== undefined ? Number(camposBody.valor_frete) : Number(pedido.valor_frete || 0)
    const subtotalAnterior = Number(pedido.total) + Number(pedido.desconto || 0) - Number(pedido.valor_frete || 0)
    const subtotalFinal = subtotal !== null ? subtotal : subtotalAnterior
    const novoTotal = Math.round((subtotalFinal - desconto + valorFrete) * 100) / 100

    if (novoTotal < 0) {
      return res.status(400).json({ erro: 'O valor total do pedido não pode ficar negativo' })
    }

    const historico = []
    const camposFinal = {}
    for (const campo of [...CAMPOS_EDITAVEIS_HEADER, ...CAMPOS_SENSIVEIS]) {
      if (camposBody[campo] === undefined) continue
      const numerico = ['desconto', 'valor_frete', 'peso_bruto', 'peso_liquido', 'qtde_volumes'].includes(campo)
      const valorNovo = numerico ? (camposBody[campo] != null ? Number(camposBody[campo]) : null) : camposBody[campo]
      const valorAnterior = pedido[campo]
      if (String(valorAnterior ?? '') !== String(valorNovo ?? '')) {
        historico.push({
          pedido_id: pedido.id, campo, origem: 'local', usuario_id: req.user.id,
          valor_anterior: valorAnterior != null ? String(valorAnterior) : null,
          valor_novo: valorNovo != null ? String(valorNovo) : null,
        })
      }
      camposFinal[campo] = valorNovo
    }
    // Total é recalculado sempre que itens, desconto ou frete mudam — não só
    // quando itens vêm no body (um desconto/frete sozinho já muda o total).
    const totalRecalculado = itensPreparados !== null || camposFinal.desconto !== undefined || camposFinal.valor_frete !== undefined
    if (totalRecalculado && Number(novoTotal) !== Number(pedido.total)) {
      historico.push({
        pedido_id: pedido.id, campo: 'total', origem: 'local', usuario_id: req.user.id,
        valor_anterior: String(pedido.total), valor_novo: String(novoTotal),
      })
      camposFinal.total = novoTotal
    }

    camposFinal.atualizado_em = new Date().toISOString()

    // Pedido veio do legado: registra a edição local e os campos alterados, pra
    // a próxima sincronização não sobrescrever silenciosamente (vira conflito).
    if (pedido.sistema_origem === 'legado' && (historico.length > 0 || itensPreparados)) {
      camposFinal.atualizado_localmente_em = new Date().toISOString()
      camposFinal.atualizado_localmente_por_usuario_id = req.user.id
      const camposAlterados = historico.map(h => h.campo)
      if (itensPreparados) camposAlterados.push('itens')
      const overrideAnterior = Array.isArray(pedido.campos_com_override_local) ? pedido.campos_com_override_local : []
      camposFinal.campos_com_override_local = [...new Set([...overrideAnterior, ...camposAlterados])]
    }

    const { data: pedidoAtualizado, error: erroUpdate } = await supabase
      .from('pedidos')
      .update(camposFinal)
      .eq('id', pedido.id)
      .select(SELECT_PEDIDO_DETALHE)
      .single()
    if (erroUpdate) throw erroUpdate

    if (itensPreparados) {
      const { error: errDel } = await supabase.from('pedido_itens').delete().eq('pedido_id', pedido.id)
      if (errDel) throw errDel
      const { error: errIns } = await supabase
        .from('pedido_itens').insert(itensPreparados.map(i => ({ ...i, pedido_id: pedido.id })))
      if (errIns) throw errIns
    }

    if (historico.length > 0) {
      await supabase.from('pedido_historico').insert(historico)
    }

    const { data: pedidoFinal } = await supabase.from('pedidos').select(SELECT_PEDIDO_DETALHE).eq('id', pedido.id).single()
    res.json(pedidoFinal || pedidoAtualizado)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/pedidos — criar pedido com itens
router.post('/', async (req, res) => {
  try {
    const {
      cliente_erp_id, itens, observacoes, desconto = 0,
      condicao_pagamento, forma_pagamento, lista_preco,
      vendedor_id, vendedor_nome,
      valor_frete = 0, tipo_frete, peso_bruto, peso_liquido, qtde_volumes,
    } = req.body
    const usuario_id = req.user?.id

    if (!cliente_erp_id || !Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ erro: '"cliente_erp_id" e ao menos um item são obrigatórios' })
    }

    // Busca preços dos produtos (inclui extra_precos pras listas migradas do legado)
    const ids = itens.map(i => i.produto_id)
    const { data: produtos, error: errProd } = await supabase
      .from('produtos')
      .select('id, preco_b2c, preco_b2b, preco_distribuidor, extra_precos')
      .in('id', ids)

    if (errProd) throw errProd

    const produtoMap = Object.fromEntries(produtos.map(p => [p.id, p]))

    let subtotal = 0
    const itensPreparados = itens.map(item => {
      const produto = produtoMap[item.produto_id] || {}
      const preco = item.preco_unitario ?? resolverPreco(produto, lista_preco)
      const quantidade = item.quantidade
      const sub = preco * quantidade
      subtotal += sub
      // subtotal NÃO entra aqui: pedido_itens.subtotal é GENERATED ALWAYS (quantidade * preco_unitario) no banco.
      return { produto_id: item.produto_id, quantidade, preco_unitario: preco }
    })

    const total = subtotal - Number(desconto) + Number(valor_frete)

    const { data: pedido, error: errPedido } = await supabase
      .from('pedidos')
      .insert({
        cliente_erp_id, usuario_id, total, desconto: Number(desconto), observacoes, status: 'rascunho',
        condicao_pagamento, forma_pagamento, lista_preco,
        vendedor_id: vendedor_id || null, vendedor_nome,
        valor_frete: Number(valor_frete), tipo_frete,
        peso_bruto: peso_bruto != null ? Number(peso_bruto) : null,
        peso_liquido: peso_liquido != null ? Number(peso_liquido) : null,
        qtde_volumes: qtde_volumes != null ? Number(qtde_volumes) : null,
      })
      .select()
      .single()

    if (errPedido) throw errPedido

    const { error: errItens } = await supabase
      .from('pedido_itens')
      .insert(itensPreparados.map(i => ({ ...i, pedido_id: pedido.id })))

    if (errItens) throw errItens

    const { data: pedidoCompleto } = await supabase
      .from('pedidos')
      .select('*, pedido_itens(*, produtos(nome))')
      .eq('id', pedido.id)
      .single()

    res.status(201).json(pedidoCompleto)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/pedidos/:id/status — atualizar status
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body

    if (!status || !STATUS_VALIDOS.includes(status)) {
      return res.status(400).json({ erro: `Status inválido. Use: ${STATUS_VALIDOS.join(', ')}` })
    }

    const { data, error } = await supabase
      .from('pedidos')
      .update({ status, atualizado_em: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*, leads(nome), clientes_erp(legacy_id, razao_social)')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Pedido não encontrado' })

    if (status === 'confirmado') {
      await gerarParcelas(data)

      // Trava o valor base e uma estimativa de percentual no momento da confirmação —
      // o valor real e final da comissão só é calculado quando a NF-e é autorizada
      // (lib/comissoes.js gerarComissao), podendo diferir se as vendas do vendedor
      // mudarem entre a confirmação e a autorização.
      const estimativa = data.vendedor_id ? await calcularComissaoEstimada(data.vendedor_id) : null
      const { data: pedidoAtualizado } = await supabase
        .from('pedidos')
        .update({
          valor_base_comissao: data.total,
          comissao_percentual_snapshot: estimativa?.percentual_estimado ?? null,
        })
        .eq('id', data.id)
        .select('*, leads(nome), clientes_erp(legacy_id, razao_social)')
        .single()
      if (pedidoAtualizado) Object.assign(data, pedidoAtualizado)
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// Gera as parcelas (contas_financeiras) do pedido confirmado — idempotente:
// não gera de novo se o pedido for confirmado mais de uma vez.
async function gerarParcelas(pedido) {
  const { count } = await supabase
    .from('contas_financeiras')
    .select('id', { count: 'exact', head: true })
    .eq('pedido_id', pedido.id)

  if (count > 0) return

  const dias = gerarDiasParcelas(pedido.condicao_pagamento)
  const n = dias.length
  const total = Number(pedido.total) || 0
  const hoje = new Date()

  let acumulado = 0
  const parcelas = dias.map((d, i) => {
    const ehUltima = i === n - 1
    const valor = ehUltima
      ? Math.round((total - acumulado) * 100) / 100
      : Math.round((total / n) * 100) / 100
    acumulado += valor

    const vencimento = new Date(hoje)
    vencimento.setDate(vencimento.getDate() + d)

    return {
      tipo: 'receber',
      pedido_id: pedido.id,
      descricao: `Pedido #${pedido.id.slice(-8).toUpperCase()} — Parcela ${i + 1}/${n}`,
      valor,
      vencimento: vencimento.toISOString().split('T')[0],
      status: 'aberta',
      categoria: 'Venda',
      pessoa_nome: pedido.clientes_erp?.razao_social ?? pedido.leads?.nome ?? null,
      vendedor_id: pedido.vendedor_id || null,
      codigo_cliente: pedido.clientes_erp?.legacy_id || null,
    }
  })

  await supabase.from('contas_financeiras').insert(parcelas)
}

export default router
