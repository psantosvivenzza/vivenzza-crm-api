import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { normalizarTelefone } from '../lib/telefone.js'

const router = Router()

// POST /api/public/leads — criação pública de lead (sem autenticação)
// Usado pela landing page vivenzza-distribuidores.netlify.app
// Mapeia campanha_origem (valor livre da UTM) para o enum permitido em leads.origem
function resolverOrigem(campanha_origem) {
  if (!campanha_origem) return 'site'
  const c = campanha_origem.toLowerCase()
  if (c.startsWith('meta_') || c === 'meta_ads') return 'whatsapp'
  if (c === 'instagram') return 'instagram'
  return 'site'
}

router.post('/', async (req, res) => {
  try {
    const { nome, telefone, cidade, interesse, campanha_origem } = req.body

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
        nome:             nome.trim(),
        telefone:         telefoneNormalizado,
        observacoes,
        tipo:             'distribuidor',
        etapa:            'novo',
        origem:           resolverOrigem(campanha_origem),
        campanha_origem:  campanha_origem || 'landing_direto',
        responsavel_id:   null,
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
