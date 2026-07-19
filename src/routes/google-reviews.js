import { Router } from 'express'
import { getGoogleReviews, googlePlacesConfigurado } from '../lib/googlePlaces.js'

const router = Router()

// GET /api/google-reviews — nota geral, total e as 5 avaliações mais recentes
// do Google (Place Details API), com cache diário no Supabase.
router.get('/', async (req, res) => {
  if (!googlePlacesConfigurado()) {
    return res.status(503).json({
      erro: 'Google Places ainda não configurado.',
      pendente: ['GOOGLE_PLACES_API_KEY', 'GOOGLE_PLACE_ID'].filter((k) => !process.env[k]),
    })
  }

  try {
    const dados = await getGoogleReviews()
    res.json(dados)
  } catch (err) {
    console.error('[google-reviews] erro:', err.message)
    res.status(502).json({ erro: 'Falha ao buscar avaliações do Google' })
  }
})

export default router
