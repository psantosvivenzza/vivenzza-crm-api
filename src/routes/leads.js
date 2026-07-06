import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { query as dbQuery } from '../lib/db.js'
import { normalizarTelefone } from '../lib/telefone.js'

const router = Router()

const useDb = () => !!process.env.DATABASE_URL

// GET /api/leads — listar com filtros opcionais
router.get('/', async (req, res) => {
  try {
    const { etapa, tipo, desde, origem, page = 1, limit, pageSize } = req.query
    const pageLimit = Number(pageSize ?? limit ?? 50)
    const offset = (Number(page) - 1) * pageLimit

    let query = supabase
      .from('leads')
      .select('*, usuarios!leads_responsavel_id_fkey(id, nome)', { count: 'exact' })
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

    res.json({ data, total: count, page: Number(page), pageSize: pageLimit })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/leads/:id — detalhe
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('leads')
      .select('*, tarefas(*), whatsapp_mensagens(id, direcao, mensagem, created_at)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Lead não encontrado' })

    if (req.user.role === 'vendedor' && data.responsavel_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para acessar este lead' })
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
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

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .insert({ nome, email: email || null, telefone: telefoneNormalizado, empresa, etapa, tipo, valor, valor_negociacao, observacoes, origem, responsavel_id: req.user.id })
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

    res.status(201).json(lead)
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

    if (campos.telefone !== undefined) {
      campos.telefone = normalizarTelefone(campos.telefone)
    }

    // Detecta transição para/de 'fechado' para registrar fechado_em
    if (campos.etapa !== undefined) {
      const { data: atual } = await supabase.from('leads').select('etapa').eq('id', req.params.id).single()
      if (campos.etapa === 'fechado' && atual?.etapa !== 'fechado') {
        campos.fechado_em = new Date().toISOString()
      } else if (campos.etapa !== 'fechado' && atual?.etapa === 'fechado') {
        campos.fechado_em = null
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

    res.json(data)
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
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
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
