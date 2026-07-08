import { Router } from 'express'
import { supabase } from '../lib/supabase.js'
import { normalizarTelefone } from '../lib/telefone.js'
import { enviarLeadCAPI } from '../lib/capi.js'
import { proximoVendedor } from '../lib/distribuicao.js'

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
    const { nome, telefone, cidade, interesse, campanha_origem, event_id, event_source_url } = req.body

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

    // Distribuição automática por rodízio — mesmo mecanismo usado nos leads
    // via WhatsApp (proximo_vendedor_atomic). O formulário público não tinha
    // isso; leads caíam sem responsavel_id e não apareciam pra ninguém.
    const vendedor = await proximoVendedor()
    if (vendedor) {
      const { error: erroAtribuicao } = await supabase
        .from('leads')
        .update({ responsavel_id: vendedor.id })
        .eq('id', lead.id)
      if (erroAtribuicao) {
        console.error('[public/leads] erro ao atribuir responsavel_id:', erroAtribuicao.message)
      }
    } else {
      console.error('[public/leads] sem vendedor ativo disponível para distribuição — lead', lead.id, 'ficou sem responsavel_id')
    }

    if (telefoneNormalizado) {
      await supabase.from('contatos').insert({
        lead_id:   lead.id,
        nome:      nome.trim(),
        telefone:  telefoneNormalizado,
        principal: true,
      })
    }

    // CAPI server-side: fire-and-forget — não bloqueia a resposta ao usuário
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip
    const userAgent = req.headers['user-agent'] || ''
    enviarLeadCAPI({
      event_id,
      event_source_url,
      telefone: telefoneNormalizado,
      email: req.body.email || null,
      client_ip: clientIp,
      user_agent: userAgent,
    }).catch(() => {})

    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('[public/leads]', err.message)
    res.status(500).json({ erro: 'Erro ao registrar. Tente novamente.' })
  }
})

export default router
