import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { timelineDoTituloPaginada, serializarEventoTimeline } from '../lib/collection/timeline.js'
import { adminOnly } from '../middleware/auth.js'
import { statusQuitacaoTitulo } from '../lib/collection/paymentGuard.js'
import { promessaAtivaPara, registrarPromessa, cancelarPromessaAtiva } from '../lib/collection/promises.js'
import { hojeBrtISO } from '../lib/collection/collectionContactPolicy.js'

const DIAS_MAX_PROMESSA_FUTURA = 90
const TAMANHO_MAX_OBSERVACAO = 280

function adicionarDiasISO(dataISO, dias) {
  const d = new Date(`${dataISO}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}

function validarDataPrometida(valor) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    return { valido: false, erro: '"data_prometida" precisa estar no formato YYYY-MM-DD' }
  }
  const d = new Date(`${valor}T12:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== valor) {
    return { valido: false, erro: '"data_prometida" não é uma data válida' }
  }
  const hoje = hojeBrtISO()
  if (valor < hoje) {
    return { valido: false, erro: '"data_prometida" não pode ser uma data passada' }
  }
  const limite = adicionarDiasISO(hoje, DIAS_MAX_PROMESSA_FUTURA)
  if (valor > limite) {
    return { valido: false, erro: `"data_prometida" não pode ser mais de ${DIAS_MAX_PROMESSA_FUTURA} dias no futuro` }
  }
  return { valido: true }
}

function validarObservacao(valor) {
  if (valor === undefined || valor === null || valor === '') return { valido: true, valorLimpo: null }
  if (typeof valor !== 'string') return { valido: false, erro: '"observacao" precisa ser texto' }
  const limpo = valor.trim()
  if (limpo.length === 0) return { valido: true, valorLimpo: null }
  if (limpo.length > TAMANHO_MAX_OBSERVACAO) {
    return { valido: false, erro: `"observacao" excede o limite de ${TAMANHO_MAX_OBSERVACAO} caracteres` }
  }
  if (/[<>]/.test(limpo)) {
    return { valido: false, erro: '"observacao" não pode conter os caracteres < ou >' }
  }
  return { valido: true, valorLimpo: limpo }
}

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

// GET /api/financeiro/:id/timeline — histórico cronológico de eventos do
// título (mensagem enviada/falhou, pagamento, promessa, etc.). Somente
// leitura — nenhuma mutação aqui. Metadata passa por serializarEventoTimeline
// (allowlist de campos seguros por tipo), nunca expõe `dados` bruto.
router.get('/:id/timeline', async (req, res) => {
  try {
    const { data: conta, error: erroConta } = await supabase
      .from('contas_financeiras')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroConta) throw erroConta
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' })

    const page = Math.max(1, Number(req.query.page) || 1)
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50))
    const offset = (page - 1) * limit

    const { eventos, total } = await timelineDoTituloPaginada(req.params.id, { limit, offset })

    res.json({
      titulo_id: req.params.id,
      total,
      page,
      limit,
      eventos: eventos.map(serializarEventoTimeline),
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/financeiro/:id/promessa — promessa ativa atual do título, ou null.
// Somente leitura.
router.get('/:id/promessa', async (req, res) => {
  try {
    const { data: conta, error: erroConta } = await supabase
      .from('contas_financeiras')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroConta) throw erroConta
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' })

    const promessa = await promessaAtivaPara(req.params.id)
    res.json({ promessa })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/financeiro/:id/promessa — registra promessa de pagamento pro
// título (data + observação opcional, sem valor parcial — sempre o saldo
// devedor atual do título). adminOnly: é mutation financeira/operacional,
// mesmo padrão de restrição de POST/estorno já usado neste arquivo.
//
// Se já existir promessa ativa: 409 por padrão (ação explícita e auditável,
// não substitui silenciosamente) — só substitui se o operador mandar
// `substituir: true` explicitamente no corpo, e nesse caso reusa
// registrarPromessa() (que já cancela a anterior e emite PROMESSA_SUBSTITUIDA
// — lógica existente, não duplicada aqui).
router.post('/:id/promessa', adminOnly, async (req, res) => {
  try {
    const { data: conta, error: erroConta } = await supabase
      .from('contas_financeiras')
      .select('id, pessoa_nome, telefone_cobranca, valor, valor_pago')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroConta) throw erroConta
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' })

    const status = await statusQuitacaoTitulo(req.params.id)
    if (status.quitado) {
      return res.status(409).json({ erro: 'Título não pode receber promessa neste estado', motivo: status.motivo })
    }

    const validacaoData = validarDataPrometida(req.body?.data_prometida)
    if (!validacaoData.valido) return res.status(400).json({ erro: validacaoData.erro })

    const validacaoObs = validarObservacao(req.body?.observacao)
    if (!validacaoObs.valido) return res.status(400).json({ erro: validacaoObs.erro })

    const existente = await promessaAtivaPara(req.params.id)
    if (existente && req.body?.substituir !== true) {
      return res.status(409).json({
        erro: 'Já existe promessa ativa para este título — envie "substituir": true pra cancelar a anterior e registrar a nova',
        promessa_existente: existente,
      })
    }

    const saldo = Number(conta.valor || 0) - Number(conta.valor_pago || 0)
    const promessa = await registrarPromessa({
      contasFinanceirasId: req.params.id,
      clienteNome: conta.pessoa_nome,
      clienteTelefone: conta.telefone_cobranca,
      valor: saldo,
      promisedDate: req.body.data_prometida,
      origem: 'HUMAN',
      notes: validacaoObs.valorLimpo,
    })

    res.status(existente ? 200 : 201).json({ promessa })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/financeiro/:id/promessa/cancelar — cancela a promessa ativa sem
// registrar uma nova (diferente de "substituir" acima). Não usa DELETE —
// nunca apaga histórico físico, só muda status e registra evento na
// timeline. adminOnly, mesmo motivo do POST acima.
router.post('/:id/promessa/cancelar', adminOnly, async (req, res) => {
  try {
    const { data: conta, error: erroConta } = await supabase
      .from('contas_financeiras')
      .select('id')
      .eq('id', req.params.id)
      .maybeSingle()
    if (erroConta) throw erroConta
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' })

    const validacaoObs = validarObservacao(req.body?.motivo)
    if (!validacaoObs.valido) return res.status(400).json({ erro: validacaoObs.erro?.replace('observacao', 'motivo') })

    const cancelada = await cancelarPromessaAtiva(req.params.id, { origem: 'HUMAN', motivo: validacaoObs.valorLimpo })
    if (!cancelada) return res.status(404).json({ erro: 'Nenhuma promessa ativa para cancelar' })

    res.json({ promessa: cancelada })
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
// Chama fn_baixar_titulo (RPC atômica, trava a conta com FOR UPDATE) — cria uma
// linha em baixas_financeiras e recalcula valor_pago/status a partir da soma
// das baixas ativas. Vendedor só pode dar baixa em títulos vinculados a ele
// (vendedor_id); admin, em qualquer um. Muitos títulos legados têm vendedor_id
// nulo — nesses, só admin.
router.patch('/contas/:id/baixa', async (req, res) => {
  try {
    const { valor_recebido, data_pagamento, forma_pagamento, observacao } = req.body
    const valorRecebidoNum = Number(valor_recebido)

    if (!valorRecebidoNum || valorRecebidoNum <= 0) {
      return res.status(400).json({ erro: '"valor_recebido" deve ser maior que zero' })
    }

    const { data: conta, error: erroBusca } = await supabase
      .from('contas_financeiras')
      .select('id, vendedor_id')
      .eq('id', req.params.id)
      .single()
    if (erroBusca) throw erroBusca
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' })

    if (req.user.role === 'vendedor' && conta.vendedor_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para dar baixa neste título' })
    }

    const hoje = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase.rpc('fn_baixar_titulo', {
      p_conta_id: req.params.id,
      p_valor: valorRecebidoNum,
      p_data_pagamento: data_pagamento || hoje,
      p_forma_pagamento: forma_pagamento || null,
      p_observacao: observacao || null,
      p_usuario_id: req.user.id,
      p_origem: 'manual',
    })
    if (error) throw error

    res.json(data)
  } catch (err) {
    res.status(400).json({ erro: err.message })
  }
})

// GET /api/financeiro/contas/:contaId/baixas — histórico de baixas + estornos
// (inclusive pendentes de aprovação) de um título. Mesma regra de permissão
// da baixa: vendedor só vê as próprias.
router.get('/contas/:contaId/baixas', async (req, res) => {
  try {
    const { data: conta, error: erroConta } = await supabase
      .from('contas_financeiras')
      .select('id, vendedor_id')
      .eq('id', req.params.contaId)
      .single()
    if (erroConta) throw erroConta
    if (!conta) return res.status(404).json({ erro: 'Conta não encontrada' })
    if (req.user.role === 'vendedor' && conta.vendedor_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para ver as baixas deste título' })
    }

    const [{ data: baixas, error: erroBaixas }, { data: estornos, error: erroEstornos }] = await Promise.all([
      supabase
        .from('baixas_financeiras')
        .select(`
          *,
          criado_por:usuarios!baixas_financeiras_criado_por_usuario_id_fkey(id, nome),
          estornado_por:usuarios!baixas_financeiras_estornado_por_usuario_id_fkey(id, nome)
        `)
        .eq('conta_financeira_id', req.params.contaId)
        .order('criado_em', { ascending: false }),
      supabase
        .from('estornos_financeiros')
        .select(`
          *,
          solicitado_por:usuarios!estornos_financeiros_solicitado_por_usuario_id_fkey(id, nome),
          aprovado_por:usuarios!estornos_financeiros_aprovado_por_usuario_id_fkey(id, nome),
          rejeitado_por:usuarios!estornos_financeiros_rejeitado_por_usuario_id_fkey(id, nome)
        `)
        .eq('conta_financeira_id', req.params.contaId)
        .order('solicitado_em', { ascending: false }),
    ])
    if (erroBaixas) throw erroBaixas
    if (erroEstornos) throw erroEstornos

    res.json({ data: baixas || [], estornos: estornos || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/financeiro/contas/:contaId/baixas/:baixaId/estornos — solicita o
// estorno de UMA baixa específica (nunca zera a conta inteira). Só admin.
// Abaixo de LIMITE_ESTORNO_SEM_APROVACAO conclui na hora; acima, fica
// pendente_aprovacao até outro admin aprovar/rejeitar (fn_estornar_baixa decide).
const CATEGORIAS_MOTIVO_ESTORNO = [
  'titulo_errado', 'valor_incorreto', 'pagamento_nao_confirmado', 'baixa_duplicada', 'devolucao_chargeback', 'outro',
]
router.post('/contas/:contaId/baixas/:baixaId/estornos', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas administradores podem estornar baixas' })
    }

    const { motivo_categoria, motivo_detalhado, confirmacao } = req.body
    if (!CATEGORIAS_MOTIVO_ESTORNO.includes(motivo_categoria)) {
      return res.status(400).json({ erro: '"motivo_categoria" inválida' })
    }
    if (!motivo_detalhado?.trim()) {
      return res.status(400).json({ erro: '"motivo_detalhado" é obrigatório' })
    }
    if (!confirmacao) {
      return res.status(400).json({ erro: 'É necessário confirmar que revisou o impacto financeiro deste estorno' })
    }

    const { data: baixa, error: erroBaixa } = await supabase
      .from('baixas_financeiras')
      .select('id, conta_financeira_id')
      .eq('id', req.params.baixaId)
      .single()
    if (erroBaixa) throw erroBaixa
    if (!baixa) return res.status(404).json({ erro: 'Baixa não encontrada' })
    if (baixa.conta_financeira_id !== req.params.contaId) {
      return res.status(400).json({ erro: 'Esta baixa não pertence ao título informado' })
    }

    const limite = Number(process.env.LIMITE_ESTORNO_SEM_APROVACAO || 1000)
    const { data, error } = await supabase.rpc('fn_estornar_baixa', {
      p_baixa_id: req.params.baixaId,
      p_usuario_id: req.user.id,
      p_motivo_categoria: motivo_categoria,
      p_motivo_detalhado: motivo_detalhado,
      p_limite_sem_aprovacao: limite,
    })
    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    res.status(400).json({ erro: err.message })
  }
})

// GET /api/financeiro/estornos/pendentes — fila de aprovação (admin)
router.get('/estornos/pendentes', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas administradores' })

    const { data, error } = await supabase
      .from('estornos_financeiros')
      .select(`
        *,
        baixas_financeiras(id, valor_baixado, data_pagamento, forma_pagamento, origem),
        contas_financeiras(id, pessoa_nome, descricao, documento_ref, valor, valor_pago),
        solicitado_por:usuarios!estornos_financeiros_solicitado_por_usuario_id_fkey(id, nome)
      `)
      .eq('status', 'pendente_aprovacao')
      .order('solicitado_em', { ascending: true })
    if (error) throw error

    res.json({ data: data || [] })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/financeiro/estornos/:estornoId/aprovar — só admin, e nunca quem solicitou
router.patch('/estornos/:estornoId/aprovar', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas administradores podem aprovar estornos' })

    const { data, error } = await supabase.rpc('fn_aprovar_estorno', {
      p_estorno_id: req.params.estornoId,
      p_usuario_id: req.user.id,
    })
    if (error) throw error

    res.json(data)
  } catch (err) {
    res.status(400).json({ erro: err.message })
  }
})

// PATCH /api/financeiro/estornos/:estornoId/rejeitar — motivo obrigatório
router.patch('/estornos/:estornoId/rejeitar', async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ erro: 'Apenas administradores podem rejeitar estornos' })

    const { motivo_rejeicao } = req.body
    if (!motivo_rejeicao?.trim()) {
      return res.status(400).json({ erro: '"motivo_rejeicao" é obrigatório' })
    }

    const { data, error } = await supabase.rpc('fn_rejeitar_estorno', {
      p_estorno_id: req.params.estornoId,
      p_usuario_id: req.user.id,
      p_motivo_rejeicao: motivo_rejeicao,
    })
    if (error) throw error

    res.json(data)
  } catch (err) {
    res.status(400).json({ erro: err.message })
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
