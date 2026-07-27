import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/cfops?search=termo — autocomplete de CFOP por código ou descrição.
// Usado no wizard de NF-e (série 1 e série 99) — ambas têm acesso ao cadastro
// completo, sem restrição de CFOP por tipo de documento.
router.get('/', async (req, res) => {
  try {
    const { search, limit = 50 } = req.query

    let query = supabase
      .from('cfops')
      .select('codigo, descricao')
      .order('codigo', { ascending: true })
      .limit(Number(limit))

    if (search) query = query.or(`codigo.ilike.%${search}%,descricao.ilike.%${search}%`)

    const { data, error } = await query
    if (error) throw error

    // id = codigo pra reaproveitar o BuscaAutocomplete do frontend (que espera
    // um campo `id` único em cada resultado pra usar de key).
    res.json(data.map(c => ({ id: c.codigo, codigo: c.codigo, descricao: c.descricao })))
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
