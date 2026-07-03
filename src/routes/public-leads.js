import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { normalizarTelefone } from '../lib/telefone.js'

const router = Router()

// POST /api/public/leads — criação pública de lead (sem autenticação)
// Usado pela landing page vivenzza-distribuidores.netlify.app
router.post('/', async (req, res) => {
  try {
    const { nome, telefone, cidade, interesse } = req.body

    if (!nome?.trim())     return res.status(400).json({ erro: 'Nome é obrigatório' })
    if (!telefone?.trim()) return res.status(400).json({ erro: 'WhatsApp é obrigatório' })

    const telefoneNormalizado = normalizarTelefone(telefone)

    const partes = [
      cidade    ? `Cidade/Estado: ${cidade}`   : null,
      interesse ? `Interesse: ${interesse}`     : null,
    ].filter(Boolean)
    const observacoes = partes.length ? partes.join(' | ') : null

    const { data: lead, error } = await supabase
      .from('leads')
      .insert({
        nome:           nome.trim(),
        telefone:       telefoneNormalizado,
        observacoes,
        tipo:           'B2B',
        etapa:          'novo',
        origem:         'google_ads_search',
        responsavel_id: null,
      })
      .select('id')
      .single()

    if (error) throw error

    if (telefoneNormalizado) {
      await supabase.from('contatos').insert({
        lead_id:   lead.id,
        nome:      nome.trim(),
        telefone:  telefoneNormalizado,
        principal: true,
      })
    }

    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('[public/leads]', err.message)
    res.status(500).json({ erro: 'Erro ao registrar. Tente novamente.' })
  }
})

export default router
