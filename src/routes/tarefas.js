import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'

const router = Router()

// Converte uma data 'YYYY-MM-DD' no dia correspondente em Brasília (UTC-3)
// para os limites UTC desse dia — meia-noite BRT = 03:00 UTC.
function diaBrtParaUtc(dataStr) {
  const [ano, mes, dia] = dataStr.split('-').map(Number)
  return {
    inicio: new Date(Date.UTC(ano, mes - 1, dia, 3, 0, 0, 0)).toISOString(),
    fim: new Date(Date.UTC(ano, mes - 1, dia + 1, 2, 59, 59, 999)).toISOString(),
  }
}

// GET /api/tarefas
router.get('/', async (req, res) => {
  try {
    const {
      lead_id, status, hoje, data_inicio, data_fim, responsavel_id, lead_busca,
      page = 1, limit = 50,
    } = req.query
    const offset = (Number(page) - 1) * Number(limit)
    const agora = new Date().toISOString()

    // Busca por lead vinculado (nome ou telefone) — resolve pra uma lista de lead_id
    // antes de filtrar tarefas, evita depender de filtro em recurso aninhado no PostgREST.
    let leadIdsBusca = null
    if (lead_busca?.trim()) {
      const termo = `%${lead_busca.trim()}%`
      // Duas queries separadas (nome, telefone) em vez de `.or()` — evita que vírgulas
      // ou parênteses no termo de busca (comuns em razão social) quebrem a sintaxe do filtro.
      const [porNome, porTelefone] = await Promise.all([
        supabase.from('leads').select('id').ilike('nome', termo),
        supabase.from('leads').select('id').ilike('telefone', termo),
      ])
      if (porNome.error) throw porNome.error
      if (porTelefone.error) throw porTelefone.error
      leadIdsBusca = [...new Set([...porNome.data, ...porTelefone.data].map((l) => l.id))]
    }

    // Aplica os filtros compartilhados (período, responsável, lead) numa query nova —
    // usado tanto pra listagem quanto pros contadores de resumo, que não podem
    // reaproveitar o mesmo builder do supabase-js.
    function comFiltrosComuns(query) {
      if (req.user.role === 'vendedor') {
        query = query.eq('responsavel_id', req.user.id)
      } else if (responsavel_id) {
        query = query.eq('responsavel_id', responsavel_id)
      }

      if (lead_id) query = query.eq('lead_id', lead_id)
      if (leadIdsBusca) query = query.in('lead_id', leadIdsBusca.length ? leadIdsBusca : ['__nenhum__'])

      if (hoje === 'true') {
        const { inicio, fim } = diaBrtParaUtc(new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10))
        query = query.gte('prazo', inicio).lte('prazo', fim)
      } else if (data_inicio && data_fim) {
        query = query.gte('prazo', diaBrtParaUtc(data_inicio).inicio).lte('prazo', diaBrtParaUtc(data_fim).fim)
      }

      return query
    }

    let query = comFiltrosComuns(
      supabase
        .from('tarefas')
        .select('*, leads(id, nome, telefone, tipo, etapa)', { count: 'exact' })
        .order('prazo', { ascending: true })
        .range(offset, offset + Number(limit) - 1)
    )

    // "atrasada" é virtual (não existe no banco): pendente com prazo já vencido
    if (status === 'atrasada') {
      query = query.eq('status', 'pendente').lt('prazo', agora)
    } else if (status) {
      query = query.eq('status', status)
    } else if (hoje === 'true') {
      // Compatibilidade com o uso original de `hoje` (Dashboard/alarme): só pendentes
      query = query.neq('status', 'concluida')
    }

    const [{ data, error, count }, resumo] = await Promise.all([
      query,
      (async () => {
        const contar = async (aplicarStatus) => {
          let q = comFiltrosComuns(supabase.from('tarefas').select('id', { count: 'exact', head: true }))
          q = aplicarStatus(q)
          const { count, error } = await q
          if (error) throw error
          return count ?? 0
        }
        const [total, concluidas, pendentes, atrasadas] = await Promise.all([
          contar((q) => q),
          contar((q) => q.eq('status', 'concluida')),
          contar((q) => q.eq('status', 'pendente')),
          contar((q) => q.eq('status', 'pendente').lt('prazo', agora)),
        ])
        return { total, concluidas, pendentes, atrasadas }
      })(),
    ])
    if (error) throw error

    res.json({ data, total: count, page: Number(page), limit: Number(limit), resumo })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// GET /api/tarefas/:id
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tarefas')
      .select('*, leads(id, nome, telefone, tipo, etapa)')
      .eq('id', req.params.id)
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Tarefa não encontrada' })

    if (req.user.role === 'vendedor' && data.responsavel_id !== req.user.id) {
      return res.status(403).json({ erro: 'Sem permissão para acessar esta tarefa' })
    }

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// POST /api/tarefas
router.post('/', async (req, res) => {
  try {
    const { lead_id, titulo, descricao, prazo, tipo = 'outro' } = req.body

    if (!titulo?.trim()) return res.status(400).json({ erro: 'Campo "titulo" é obrigatório' })

    // origem sempre "manual" aqui — tarefas automaticas (reativacao, futuramente Lara)
    // sao inseridas direto via supabase nas rotas internas, nunca por essa API publica.
    const { data, error } = await supabase
      .from('tarefas')
      .insert({
        lead_id: lead_id || null,
        titulo,
        descricao: descricao || null,
        prazo: prazo || null,
        tipo,
        status: 'pendente',
        responsavel_id: req.user.id,
        origem: 'manual',
      })
      .select('*, leads(id, nome, telefone, tipo, etapa)')
      .single()

    if (error) throw error

    res.status(201).json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/tarefas/:id/concluir — marcar como concluída
router.patch('/:id/concluir', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
      const { data: t } = await supabase.from('tarefas').select('responsavel_id').eq('id', req.params.id).single()
      if (!t || t.responsavel_id !== req.user.id) {
        return res.status(403).json({ erro: 'Sem permissão para editar esta tarefa' })
      }
    }

    const { data, error } = await supabase
      .from('tarefas')
      .update({ status: 'concluida' })
      .eq('id', req.params.id)
      .select('*, leads(id, nome, telefone, tipo, etapa)')
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Tarefa não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PATCH /api/tarefas/:id — atualização parcial (ex: marcar concluída)
router.patch('/:id', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
      const { data: t } = await supabase.from('tarefas').select('responsavel_id').eq('id', req.params.id).single()
      if (!t || t.responsavel_id !== req.user.id) {
        return res.status(403).json({ erro: 'Sem permissão para editar esta tarefa' })
      }
    }

    const campos = { ...req.body }
    delete campos.id
    delete campos.criado_em
    delete campos.responsavel_id

    const { data, error } = await supabase
      .from('tarefas')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Tarefa não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// PUT /api/tarefas/:id — atualização completa
router.put('/:id', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
      const { data: t } = await supabase.from('tarefas').select('responsavel_id').eq('id', req.params.id).single()
      if (!t || t.responsavel_id !== req.user.id) {
        return res.status(403).json({ erro: 'Sem permissão para editar esta tarefa' })
      }
    }

    const campos = { ...req.body }
    delete campos.id
    delete campos.criado_em
    delete campos.responsavel_id

    const { data, error } = await supabase
      .from('tarefas')
      .update(campos)
      .eq('id', req.params.id)
      .select()
      .single()

    if (error) throw error
    if (!data) return res.status(404).json({ erro: 'Tarefa não encontrada' })

    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// DELETE /api/tarefas/:id
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role === 'vendedor') {
      const { data: t } = await supabase.from('tarefas').select('responsavel_id').eq('id', req.params.id).single()
      if (!t || t.responsavel_id !== req.user.id) {
        return res.status(403).json({ erro: 'Sem permissão para remover esta tarefa' })
      }
    }

    const { error } = await supabase
      .from('tarefas')
      .delete()
      .eq('id', req.params.id)

    if (error) throw error

    res.status(204).send()
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
