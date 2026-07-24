import { Router } from 'express'
import { supabase } from '../lib/supabase.js'

const router = Router()

// GET /api/clientes-erp/busca?search=termo — autocomplete de cliente pra Pedidos.
// Rota separada de /api/admin/erp (adminOnly) de propósito: qualquer vendedor
// autenticado precisa poder buscar cliente pra criar um pedido, não só admin.
router.get('/busca', async (req, res) => {
  try {
    const termo = (req.query.search || '').trim()
    if (termo.length < 2) return res.json([])

    const like = `%${termo}%`
    const { data, error } = await supabase
      .from('clientes_erp')
      .select('id, legacy_id, tipo, razao_social, nome_fantasia, cnpj_cpf, data_ultima_compra')
      .eq('ativo', true)
      .or(`razao_social.ilike.${like},nome_fantasia.ilike.${like},cnpj_cpf.ilike.${like}`)
      .order('razao_social')
      .limit(15)

    if (error) throw error
    res.json(data)
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
