import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { query as dbQuery } from '../lib/db.js'
import { normalizarTelefone, candidatosTelefone } from '../lib/telefone.js'
import { criarCircuitBreaker, CircuitBreakerAbertoError } from '../lib/circuitBreaker.js'
import { criarCacheComSingleFlight } from '../lib/singleFlightCache.js'

const router = Router()

const useDb = () => !!process.env.DATABASE_URL

// ── Contenção de cascata (incidente 2026-09-28) ────────────────────────────
// Cloudflare 522 no host do Supabase + respostas de 90-300s. GET /api/leads
// é pollado (useLeadPolling, 30s) e refeito página-a-página a cada 30s pelo
// board (Pipeline.jsx refreshSilently) por CADA aba aberta — sem nada aqui,
// cada requisição nova esperava o timeout inteiro (ou pior, sem timeout
// nenhum, o tempo que o Supabase levasse) antes de desistir, empilhando
// dezenas de chamadas concorrentes contra um backend que já estava afogado.
// Isso também expirou webhooks da Evolution API (ver src/lib/distribuicao.js),
// que dependem do processo Node responder rápido.
//
// Três camadas, compostas:
// 1. Timeout fail-fast (.abortSignal) — nenhuma chamada individual trava
//    indefinidamente. Mesmo padrão de SDR_QUERY_TIMEOUT_MS (sdr.js) e
//    ATENDIMENTO_QUERY_TIMEOUT_MS (dashboard.js).
// 2. Circuit breaker (src/lib/circuitBreaker.js) — depois de falhas
//    consecutivas, para de tentar por um cooldown e rejeita na hora, sem
//    tocar o Supabase. Compartilhado entre leitura e escrita: a causa raiz
//    (Supabase indisponível) afeta as duas igualmente.
// 3. Cache curto + single-flight (src/lib/singleFlightCache.js) — coalesce
//    requisições concorrentes pro mesmo escopo+filtros numa única execução
//    real, mesmo padrão já usado em GET /api/dashboard/atendimento.
const LEADS_QUERY_TIMEOUT_MS = Number(process.env.LEADS_QUERY_TIMEOUT_MS) || 8000
const LEADS_LIST_CACHE_TTL_MS = Number(process.env.LEADS_LIST_CACHE_TTL_MS) || 3000

const breakerLeads = criarCircuitBreaker({
  chave: 'leads',
  falhasParaAbrir: Number(process.env.LEADS_BREAKER_FALHAS_PARA_ABRIR) || 5,
  cooldownMs: Number(process.env.LEADS_BREAKER_COOLDOWN_MS) || 15000,
  cooldownMaxMs: Number(process.env.LEADS_BREAKER_COOLDOWN_MAX_MS) || 120000,
})

// Mapeia o erro pra uma resposta HTTP coerente com a causa: circuito aberto
// (503 + Retry-After, nunca tocou o Supabase), timeout (504, Supabase lento
// demais) ou qualquer outro erro de aplicação/banco (500, comportamento
// anterior preservado).
function responderErroSupabase(res, err) {
  if (err instanceof CircuitBreakerAbertoError) {
    res.set('Retry-After', String(Math.ceil(err.retryAposMs / 1000)))
    return res.status(503).json({ erro: err.message })
  }
  if (err?.name === 'AbortError') {
    return res.status(504).json({ erro: 'Tempo de resposta do banco de dados excedido — tente novamente em instantes.' })
  }
  return res.status(500).json({ erro: err.message })
}

async function computarListaLeads({ filtroVendedorId, etapa, tipo, desde, origem, page, pageLimit, offset }) {
  return breakerLeads.executar(async () => {
    let query = supabase
      .from('leads')
      .select('*, usuarios!leads_responsavel_id_fkey(id, nome), clientes_erp!leads_cliente_erp_id_fkey(id, legacy_id, razao_social, cnpj_cpf, data_ultima_compra)', { count: 'exact' })
      .order('criado_em', { ascending: false })
      .range(offset, offset + pageLimit - 1)
      .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))

    if (etapa) query = query.eq('etapa', etapa)
    if (tipo) query = query.eq('tipo', tipo)
    if (desde) query = query.gt('criado_em', desde)
    if (origem) query = query.eq('origem', origem)
    if (filtroVendedorId) query = query.eq('responsavel_id', filtroVendedorId)

    const { data, error, count } = await query
    if (error) throw error

    // Indicador "mensagem pendente" (cliente falou por último, ainda sem resposta) —
    // uma chamada só pra página inteira via RPC, não N+1 por lead.
    let leadIdsComMensagemPendente = new Set()
    if (data?.length) {
      const { data: pendentes, error: erroPendentes } = await supabase
        .rpc('leads_com_mensagem_pendente', { p_lead_ids: data.map((l) => l.id) })
        .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
      if (erroPendentes) console.error('[leads] erro ao checar mensagens pendentes:', erroPendentes.message)
      else leadIdsComMensagemPendente = new Set(pendentes.map((p) => p.lead_id))
    }

    const dataComPendencia = (data ?? []).map((lead) => ({
      ...lead,
      tem_mensagem_pendente: leadIdsComMensagemPendente.has(lead.id),
      cliente_erp_vinculado: lead.clientes_erp ?? null,
    }))

    return { data: dataComPendencia, total: count, page: Number(page), pageSize: pageLimit }
  })
}

// Escopo do cache: vendedor_id (vendedor só vê a própria carteira) ou 'geral'
// (admin sem filtro), combinado com os filtros da querystring — chaves
// diferentes NUNCA coalescem entre si (ver src/lib/singleFlightCache.js).
const cacheListaLeads = criarCacheComSingleFlight({
  ttlMs: LEADS_LIST_CACHE_TTL_MS,
  computar: computarListaLeads,
})

async function buscarLeadPorId(id) {
  return breakerLeads.executar(async () => {
    const { data, error } = await supabase
      .from('leads')
      .select('*, tarefas(*), whatsapp_mensagens(id, direcao, mensagem, created_at), clientes_erp!leads_cliente_erp_id_fkey(id, legacy_id, razao_social, cnpj_cpf, data_ultima_compra)')
      .eq('id', id)
      .single()
      .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
    if (error) throw error
    return data
  })
}

// Cache/single-flight por id, sem distinção de usuário: o dado bruto do lead
// é o mesmo pra qualquer chamador — o controle de acesso (vendedor só vê o
// próprio lead) é aplicado DEPOIS, na rota, sobre o resultado (cacheado ou
// não), então cachear aqui nunca vaza dado pra quem não deveria ver.
const cacheLeadPorId = criarCacheComSingleFlight({
  ttlMs: LEADS_LIST_CACHE_TTL_MS,
  computar: buscarLeadPorId,
})

// GET /api/leads — listar com filtros opcionais
router.get('/', async (req, res) => {
  try {
    const { etapa, tipo, desde, origem, page = 1, limit, pageSize } = req.query
    const pageLimit = Number(pageSize ?? limit ?? 50)
    const offset = (Number(page) - 1) * pageLimit

    // Vendedor só vê os leads atribuídos a ele.
    const filtroVendedorId = req.user.role === 'vendedor' ? req.user.id : null

    const params = {
      filtroVendedorId,
      etapa: etapa || null,
      tipo: tipo || null,
      desde: desde || null,
      origem: origem || null,
      page: Number(page),
      pageLimit,
      offset,
    }
    const chaveEscopo = filtroVendedorId || 'geral'
    const chave = `${chaveEscopo}|${JSON.stringify({ etapa: params.etapa, tipo: params.tipo, desde: params.desde, origem: params.origem, page: params.page, pageLimit })}`

    const resultado = await cacheListaLeads.obter(chave, params)
    res.json(resultado)
  } catch (err) {
    responderErroSupabase(res, err)
  }
})

// GET /api/leads/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const data = await cacheLeadPorId.obter(req.params.id, req.params.id)
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    if (req.user.role === 'vendedor' && data.responsavel_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para acessar este lead' })
    }

    res.json({ ...data, cliente_erp_vinculado: data.clientes_erp ?? null })
  } catch (err) {
    responderErroSupabase(res, err)
  }
})

// POST /api/leads — criar
router.post('/', async (req, res) => {
  try {
    const { nome, email, telefone, empresa, etapa = 'novo', tipo, valor, valor_negociacao, observacoes, origem } = req.body

    if (!nome) return res.status(400).json({ erro: 'Campo "nome" é obrigatório' })

    // Mantém só os dígitos — telefone digitado com espaço/hífen/parênteses não batia com
    // as variações geradas por candidatosTelefone, e o webhook acabava criando um lead
    // duplicado quando o cliente respondia pelo WhatsApp.
    const telefoneNormalizado = normalizarTelefone(telefone)

    const lead = await breakerLeads.executar(async () => {
      // Sem constraint UNIQUE no banco, um telefone repetido era inserido sem aviso — a
      // vendedora não tinha como saber que já existia lead pra esse número.
      if (telefoneNormalizado) {
        const { data: existente, error: erroExistente } = await supabase
          .from('leads')
          .select('id, nome')
          .in('telefone', candidatosTelefone(telefoneNormalizado))
          .limit(1)
          .maybeSingle()
          .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
        if (erroExistente) throw erroExistente

        if (existente) {
          const conflito = new Error(`Já existe um lead com esse telefone: "${existente.nome}".`)
          conflito.status = 409
          conflito.leadId = existente.id
          throw conflito
        }
      }

      const { data: novoLead, error: leadError } = await supabase
        .from('leads')
        .insert({ nome, email: email || null, telefone: telefoneNormalizado, empresa, etapa, tipo, valor, valor_negociacao, observacoes, origem, responsavel_id: req.user.id })
        .select()
        .single()
        .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))

      if (leadError) throw leadError

      // Se email ou telefone fornecidos, cria contato principal vinculado ao lead
      if (email || telefoneNormalizado) {
        const { error: contatoError } = await supabase
          .from('contatos')
          .insert({ lead_id: novoLead.id, nome, telefone: telefoneNormalizado, email: email || null, principal: true })
          .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))

        if (contatoError) throw contatoError
      }

      return novoLead
    })

    cacheListaLeads.invalidar()
    res.status(201).json(lead)
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ erro: err.message, lead_id: err.leadId })
    }
    responderErroSupabase(res, err)
  }
})

// PUT /api/leads/:id — atualizar
router.put('/:id', async (req, res) => {
  try {
    const data = await breakerLeads.executar(async () => {
      if (req.user.role === 'vendedor') {
        const { data: lead, error: erroLead } = await supabase
          .from('leads').select('responsavel_id').eq('id', req.params.id).single()
          .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
        if (erroLead && erroLead.code !== 'PGRST116') throw erroLead
        if (!lead || lead.responsavel_id !== req.user.id) {
          const semPermissao = new Error('Sem permissão para editar este lead')
          semPermissao.status = 403
          throw semPermissao
        }
      }

      const campos = req.body
      delete campos.id
      delete campos.created_at

      if (campos.telefone !== undefined) {
        campos.telefone = normalizarTelefone(campos.telefone)
      }

      // Detecta transição para/de 'fechado' para registrar fechado_em
      if (campos.etapa !== undefined) {
        const { data: atual, error: erroAtual } = await supabase
          .from('leads').select('etapa').eq('id', req.params.id).single()
          .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
        if (erroAtual && erroAtual.code !== 'PGRST116') throw erroAtual
        if (campos.etapa === 'fechado' && atual?.etapa !== 'fechado') {
          campos.fechado_em = new Date().toISOString()
        } else if (campos.etapa !== 'fechado' && atual?.etapa === 'fechado') {
          campos.fechado_em = null
        }
      }

      const { data: atualizado, error } = await supabase
        .from('leads')
        .update({ ...campos, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single()
        .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))

      if (error) throw error
      return atualizado
    })

    cacheListaLeads.invalidar()
    cacheLeadPorId.invalidar(req.params.id)

    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })
    res.json(data)
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ erro: err.message })
    responderErroSupabase(res, err)
  }
})

// PUT /api/leads/:id/etapa — mover no pipeline
router.put('/:id/etapa', async (req, res) => {
  try {
    const { etapa } = req.body
    const etapasValidas = ['novo', 'contato', 'proposta', 'negociacao', 'fechado', 'perdido']
    if (!etapa || !etapasValidas.includes(etapa)) {
      return res.status(400).json({ erro: `Etapa inválida. Use: ${etapasValidas.join(', ')}` })
    }

    const data = await breakerLeads.executar(async () => {
      if (req.user.role === 'vendedor') {
        const { data: lead, error: erroLead } = await supabase
          .from('leads').select('responsavel_id').eq('id', req.params.id).single()
          .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
        if (erroLead && erroLead.code !== 'PGRST116') throw erroLead
        if (!lead || lead.responsavel_id !== req.user.id) {
          const semPermissao = new Error('Sem permissão para mover este lead')
          semPermissao.status = 403
          throw semPermissao
        }
      }

      const agora = new Date().toISOString()
      const updateData = { etapa, updated_at: agora }
      // Registra o momento exato em que o lead foi movido para fechado
      if (etapa === 'fechado') updateData.fechado_em = agora
      else updateData.fechado_em = null // saiu de fechado — reseta

      const { data: atualizado, error } = await supabase
        .from('leads')
        .update(updateData)
        .eq('id', req.params.id)
        .select()
        .single()
        .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))

      if (error) throw error
      return atualizado
    })

    cacheListaLeads.invalidar()
    cacheLeadPorId.invalidar(req.params.id)

    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })
    res.json(data)
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ erro: err.message })
    responderErroSupabase(res, err)
  }
})

// PUT /api/leads/:id/devolver-lara — devolve o lead para Lara (atendimento_humano = false)
router.put('/:id/devolver-lara', async (req, res) => {
  try {
    const data = await breakerLeads.executar(async () => {
      if (req.user.role === 'vendedor') {
        const { data: lead, error: erroLead } = await supabase
          .from('leads').select('responsavel_id').eq('id', req.params.id).single()
          .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
        if (erroLead && erroLead.code !== 'PGRST116') throw erroLead
        if (!lead || lead.responsavel_id !== req.user.id) {
          const semPermissao = new Error('Sem permissão para editar este lead')
          semPermissao.status = 403
          throw semPermissao
        }
      }

      const { data: atualizado, error } = await supabase
        .from('leads')
        .update({ atendimento_humano: false, handoff_alerta_nivel: 0, updated_at: new Date().toISOString() })
        .eq('id', req.params.id)
        .select()
        .single()
        .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))

      if (error) throw error
      return atualizado
    })

    cacheListaLeads.invalidar()
    cacheLeadPorId.invalidar(req.params.id)

    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })
    res.json({ sucesso: true, lead: data })
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ erro: err.message })
    responderErroSupabase(res, err)
  }
})

// DELETE /api/leads/:id — remover (admin only)
//
// Achado da auditoria adversarial de mounts/autorização de 2026-09-13: era
// `if (req.user.role === 'vendedor')` — uma denylist que só bloqueava
// 'vendedor', deixando passar qualquer outro papel, inclusive 'financeiro'
// (introduzido em 2026-09-07 só para /api/financeiro — ver comentário em
// routes/usuarios.js). Mesmo antipadrão que middleware/auth.js já documenta
// ter sido abandonado nas rotas financeiras ("diferente do gate de posse
// anterior (role==='vendedor')..."), nunca corrigido aqui. Todo outro "admin
// only" do código (pedidos.js, cobrancas.js, comissoes.js, nfe-entradas.js,
// notifications.js, usuarios.js, relatorios.js) já usa `role !== 'admin'`
// ou o middleware `adminOnly`.
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ erro: 'Apenas administradores podem remover leads' })
    }

    await breakerLeads.executar(async () => {
      const { error } = await supabase
        .from('leads')
        .delete()
        .eq('id', req.params.id)
        .abortSignal(AbortSignal.timeout(LEADS_QUERY_TIMEOUT_MS))
      if (error) throw error
    })

    cacheListaLeads.invalidar()
    cacheLeadPorId.invalidar(req.params.id)

    res.status(204).send()
  } catch (err) {
    responderErroSupabase(res, err)
  }
})

export default router
