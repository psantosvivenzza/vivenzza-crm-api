import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { query as dbQuery } from '../lib/db.js'
import { normalizarTelefone, candidatosTelefone } from '../lib/telefone.js'

const router = Router()

const useDb = () => !!process.env.DATABASE_URL

// --- Territórios de distribuidor (cidades de atendimento) -----------------
// Regra de negócio: só pode haver 1 distribuidor ATIVO por cidade/UF (constraint
// uq_distribuidor_cidade_ativa no banco garante isso em nível de dado também).
// Quando o lead vira inativo, a cidade é liberada automaticamente para outro
// distribuidor poder assumir.

async function buscarCidadesAtendimento(leadId) {
  const { data, error } = await supabase
    .from('distribuidor_cidades')
    .select('id, cidade, estado')
    .eq('lead_id', leadId)
    .eq('ativo', true)
    .order('estado')
    .order('cidade')
  if (error) throw error
  return data ?? []
}

async function liberarCidadesDoDistribuidor(leadId) {
  const { error } = await supabase
    .from('distribuidor_cidades')
    .update({ ativo: false, atualizado_em: new Date().toISOString() })
    .eq('lead_id', leadId)
    .eq('ativo', true)
  if (error) throw error
}

// Substitui o conjunto de cidades ativas de um distribuidor pelo novo conjunto
// enviado no form. Lança erro com código 'TERRITORIO_OCUPADO' se alguma cidade
// já tiver distribuidor ativo diferente deste lead.
async function definirCidadesAtendimento(leadId, cidadesNovas) {
  const normalizadas = (cidadesNovas ?? [])
    .map((c) => ({ cidade: String(c.cidade ?? '').trim(), estado: String(c.estado ?? '').trim().toUpperCase() }))
    .filter((c) => c.cidade && c.estado)

  // Checa conflito ANTES de mexer em qualquer linha, pra dar erro claro em vez
  // de deixar a constraint do banco estourar no meio da operação.
  for (const c of normalizadas) {
    const { data: ocupante, error } = await supabase
      .from('distribuidor_cidades')
      .select('lead_id, leads!distribuidor_cidades_lead_id_fkey(nome, empresa)')
      .eq('estado', c.estado)
      .ilike('cidade', c.cidade)
      .eq('ativo', true)
      .neq('lead_id', leadId)
      .maybeSingle()
    if (error) throw error
    if (ocupante) {
      const nomeOcupante = ocupante.leads?.empresa || ocupante.leads?.nome || 'outro distribuidor'
      const erro = new Error(`A cidade ${c.cidade}/${c.estado} já tem distribuidor ativo: ${nomeOcupante}.`)
      erro.code = 'TERRITORIO_OCUPADO'
      throw erro
    }
  }

  await liberarCidadesDoDistribuidor(leadId)

  if (normalizadas.length) {
    // Insert simples (não upsert): a unicidade real é uma expressão parcial
    // (estado, lower(cidade)) WHERE ativo = true, que o onConflict do client
    // não sabe mirar. Já liberamos as linhas antigas deste lead acima e já
    // validamos que nenhum OUTRO lead tem a cidade ativa, então um insert
    // direto é seguro; se mesmo assim colidir, a constraint do banco barra.
    const { error } = await supabase
      .from('distribuidor_cidades')
      .insert(normalizadas.map((c) => ({ lead_id: leadId, cidade: c.cidade, estado: c.estado, ativo: true })))
    if (error) {
      if (error.code === '23505') {
        const erro = new Error('Uma das cidades selecionadas já tem distribuidor ativo (conflito ao salvar).')
        erro.code = 'TERRITORIO_OCUPADO'
        throw erro
      }
      throw error
    }
  }

  return buscarCidadesAtendimento(leadId)
}

// GET /api/leads — listar com filtros opcionais
router.get('/', async (req, res) => {
  try {
    const { etapa, tipo, desde, origem, page = 1, limit, pageSize } = req.query
    const pageLimit = Number(pageSize ?? limit ?? 50)
    const offset = (Number(page) - 1) * pageLimit

    let query = supabase
      .from('leads')
      .select('*, usuarios!leads_responsavel_id_fkey(id, nome), clientes_erp!leads_cliente_erp_id_fkey(id, legacy_id, razao_social, cnpj_cpf, data_ultima_compra)', { count: 'exact' })
      .order('criado_em', { ascending: false })
      .range(offset, offset + pageLimit - 1)

    if (etapa) query = query.eq('etapa', etapa)
    if (tipo) query = query.eq('tipo', tipo)
    if (desde) query = query.gt('criado_em', desde)
    if (origem) query = query.eq('origem', origem)

    // Vendedor só vê os leads atribuídos a ele
    if (req.user.role === 'vendedor') {
      query = query.eq('responsavel_id', req.user.id)
    }

    const { data, error, count } = await query

    if (error) throw error

    // Indicador "mensagem pendente" (cliente falou por último, ainda sem resposta) —
    // uma chamada só pra página inteira via RPC, não N+1 por lead.
    let leadIdsComMensagemPendente = new Set()
    if (data?.length) {
      const { data: pendentes, error: erroPendentes } = await supabase.rpc('leads_com_mensagem_pendente', {
        p_lead_ids: data.map((l) => l.id),
      })
      if (erroPendentes) console.error('[leads] erro ao checar mensagens pendentes:', erroPendentes.message)
      else leadIdsComMensagemPendente = new Set(pendentes.map((p) => p.lead_id))
    }
    const dataComPendencia = (data ?? []).map((lead) => ({
      ...lead,
      tem_mensagem_pendente: leadIdsComMensagemPendente.has(lead.id),
      cliente_erp_vinculado: lead.clientes_erp ?? null,
    }))

    res.json({ data: dataComPendencia, total: count, page: Number(page), pageSize: pageLimit })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/leads/territorios — mapa de cidades já cobertas por distribuidor ativo.
// Usado pelas vendedoras pra saber, antes de fechar uma venda direta/salão numa
// cidade, se ali já tem distribuidor (e portanto se podem ou não vender).
// Sem filtro: lista tudo. Com ?cidade=&estado=: checa uma cidade específica.
router.get('/territorios', async (req, res) => {
  try {
    const { cidade, estado } = req.query

    let query = supabase
      .from('distribuidor_cidades')
      .select('cidade, estado, lead_id, leads!distribuidor_cidades_lead_id_fkey(id, nome, empresa, ativo)')
      .eq('ativo', true)
      .order('estado')
      .order('cidade')

    if (estado) query = query.eq('estado', String(estado).toUpperCase())
    if (cidade) query = query.ilike('cidade', String(cidade).trim())

    const { data, error } = await query
    if (error) throw error

    const territorios = (data ?? []).map((t) => ({
      cidade: t.cidade,
      estado: t.estado,
      distribuidor: { id: t.leads?.id, nome: t.leads?.nome, empresa: t.leads?.empresa },
    }))

    if (cidade && estado) {
      return res.json({ ocupado: territorios.length > 0, distribuidor: territorios[0]?.distribuidor ?? null })
    }

    res.json({ data: territorios })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/leads/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*, tarefas(*), whatsapp_mensagens(id, direcao, mensagem, created_at), clientes_erp!leads_cliente_erp_id_fkey(id, legacy_id, razao_social, cnpj_cpf, data_ultima_compra)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    if (req.user.role === 'vendedor' && data.responsavel_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para acessar este lead' })
    }

    const cidadesAtendimento = data.tipo === 'distribuidor' ? await buscarCidadesAtendimento(data.id) : []

    res.json({ ...data, cliente_erp_vinculado: data.clientes_erp ?? null, cidades_atendimento: cidadesAtendimento })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/leads — criar
router.post('/', async (req, res) => {
  try {
    const { nome, email, telefone, empresa, etapa = 'novo', tipo, valor, valor_negociacao, observacoes, origem, cidade, estado, ativo, cidades_atendimento } = req.body

    if (!nome) return res.status(400).json({ erro: 'Campo "nome" é obrigatório' })

    // Mantém só os dígitos — telefone digitado com espaço/hífen/parênteses não batia com
    // as variações geradas por candidatosTelefone, e o webhook acabava criando um lead
    // duplicado quando o cliente respondia pelo WhatsApp.
    const telefoneNormalizado = normalizarTelefone(telefone)

    // Sem constraint UNIQUE no banco, um telefone repetido era inserido sem aviso — a
    // vendedora não tinha como saber que já existia lead pra esse número.
    if (telefoneNormalizado) {
      const { data: existente } = await supabase
        .from('leads')
        .select('id, nome')
        .in('telefone', candidatosTelefone(telefoneNormalizado))
        .limit(1)
        .maybeSingle()

      if (existente) {
        return res.status(409).json({
          erro: `Já existe um lead com esse telefone: "${existente.nome}".`,
          lead_id: existente.id,
        })
      }
    }

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .insert({
        nome, email: email || null, telefone: telefoneNormalizado, empresa, etapa, tipo, valor, valor_negociacao,
        observacoes, origem, responsavel_id: req.user.id,
        cidade: cidade || null, estado: estado || null, ativo: ativo ?? true,
      })
      .select()
      .single()

    if (leadError) throw leadError

    // Se email ou telefone fornecidos, cria contato principal vinculado ao lead
    if (email || telefoneNormalizado) {
      const { error: contatoError } = await supabase
        .from('contatos')
        .insert({ lead_id: lead.id, nome, telefone: telefoneNormalizado, email: email || null, principal: true })

      if (contatoError) throw contatoError
    }

    let cidadesAtendimento = []
    if (tipo === 'distribuidor' && Array.isArray(cidades_atendimento) && cidades_atendimento.length) {
      try {
        cidadesAtendimento = await definirCidadesAtendimento(lead.id, cidades_atendimento)
      } catch (err) {
        if (err.code === 'TERRITORIO_OCUPADO') {
          // O lead já foi criado; devolve 201 com aviso em vez de rollback manual
          // (não há transação cross-table aqui) — a vendedora ajusta as cidades depois.
          return res.status(201).json({ ...lead, cidades_atendimento: [], aviso_territorio: err.message })
        }
        throw err
      }
    }

    res.status(201).json({ ...lead, cidades_atendimento: cidadesAtendimento })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/leads/:id — atualizar
router.put('/:id', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
      const { data: lead } = await supabase.from('leads').select('responsavel_id').eq('id', req.params.id).single()
      if (!lead || lead.responsavel_id !== req.user.id) {
        return res.status(403).json({ erro: 'Sem permissão para editar este lead' })
      }
    }

    const campos = req.body
    delete campos.id
    delete campos.created_at
    const cidadesAtendimentoNovas = campos.cidades_atendimento
    delete campos.cidades_atendimento

    if (campos.telefone !== undefined) {
      campos.telefone = normalizarTelefone(campos.telefone)
    }

    // Detecta transição para/de 'fechado' para registrar fechado_em, e transição
    // de ativo→inativo pra saber se precisa liberar as cidades do distribuidor.
    let precisaLiberarCidades = false
    if (campos.etapa !== undefined || campos.ativo !== undefined) {
      const { data: atual } = await supabase.from('leads').select('etapa, tipo, ativo').eq('id', req.params.id).single()
      if (campos.etapa !== undefined) {
        if (campos.etapa === 'fechado' && atual?.etapa !== 'fechado') {
          campos.fechado_em = new Date().toISOString()
        } else if (campos.etapa !== 'fechado' && atual?.etapa === 'fechado') {
          campos.fechado_em = null
        }
      }
      if (campos.ativo === false && atual?.ativo !== false && (campos.tipo ?? atual?.tipo) === 'distribuidor') {
        precisaLiberarCidades = true
      }
    }

    const { data, error } = await supabase
      .from('leads')
      .update({ ...campos, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    // Inativou um distribuidor → libera automaticamente as cidades que ele
    // cobria, pra outro distribuidor poder assumir a praça.
    if (precisaLiberarCidades) {
      await liberarCidadesDoDistribuidor(data.id)
    }

    let cidadesAtendimento
    if (data.tipo === 'distribuidor') {
      if (Array.isArray(cidadesAtendimentoNovas) && data.ativo !== false) {
        try {
          cidadesAtendimento = await definirCidadesAtendimento(data.id, cidadesAtendimentoNovas)
        } catch (err) {
          if (err.code === 'TERRITORIO_OCUPADO') {
            return res.status(409).json({ erro: err.message })
          }
          throw err
        }
      } else {
        cidadesAtendimento = await buscarCidadesAtendimento(data.id)
      }
    } else {
      cidadesAtendimento = []
    }

    res.json({ ...data, cidades_atendimento: cidadesAtendimento })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/leads/:id/etapa — mover no pipeline
router.put('/:id/etapa', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
      const { data: lead } = await supabase.from('leads').select('responsavel_id').eq('id', req.params.id).single()
      if (!lead || lead.responsavel_id !== req.user.id) {
        return res.status(403).json({ erro: 'Sem permissão para mover este lead' })
      }
    }

    const { etapa } = req.body

    const etapasValidas = ['novo', 'contato', 'proposta', 'negociacao', 'fechado', 'perdido']
    if (!etapa || !etapasValidas.includes(etapa)) {
      return res.status(400).json({ erro: `Etapa inválida. Use: ${etapasValidas.join(', ')}` })
    }

    const agora = new Date().toISOString()
    const updateData = { etapa, updated_at: agora }
    // Registra o momento exato em que o lead foi movido para fechado
    if (etapa === 'fechado') updateData.fechado_em = agora
    else updateData.fechado_em = null  // saiu de fechado — reseta

    const { data, error } = await supabase
      .from('leads')
      .update(updateData)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/leads/:id/devolver-lara — devolve o lead para Lara (atendimento_humano = false)
router.put('/:id/devolver-lara', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
      const { data: lead } = await supabase.from('leads').select('responsavel_id').eq('id', req.params.id).single()
      if (!lead || lead.responsavel_id !== req.user.id) {
        return res.status(403).json({ erro: 'Sem permissão para editar este lead' })
      }
    }

    const { data, error } = await supabase
      .from('leads')
      .update({ atendimento_humano: false, handoff_alerta_nivel: 0, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    res.json({ sucesso: true, lead: data })
  } catch (err) {
    res.status(500).json({ erro: err.message })
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

    const { error } = await supabase
      .from('leads')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.status(204).send()
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
