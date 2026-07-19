import axios from 'axios'
import { supabase } from './supabase.js'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 1x por dia, pra não estourar cota

export function googlePlacesConfigurado() {
  return !!(process.env.GOOGLE_PLACES_API_KEY && process.env.GOOGLE_PLACE_ID)
}

async function getCache() {
  const { data, error } = await supabase
    .from('google_reviews_cache')
    .select('rating, user_ratings_total, reviews, atualizado_em')
    .eq('id', 1)
    .maybeSingle()

  if (error) {
    console.error('[google-reviews] erro ao ler cache:', error.message)
    return null
  }
  return data
}

async function saveCache({ rating, userRatingsTotal, reviews }) {
  const { error } = await supabase
    .from('google_reviews_cache')
    .upsert(
      {
        id: 1,
        rating,
        user_ratings_total: userRatingsTotal,
        reviews,
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
  if (error) console.error('[google-reviews] erro ao salvar cache:', error.message)
}

async function fetchFromGoogle() {
  const { GOOGLE_PLACES_API_KEY, GOOGLE_PLACE_ID } = process.env

  const { data } = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
    params: {
      place_id: GOOGLE_PLACE_ID,
      fields: 'rating,user_ratings_total,reviews',
      reviews_sort: 'newest',
      key: GOOGLE_PLACES_API_KEY,
    },
    timeout: 15000,
  })

  if (data.status !== 'OK') {
    throw new Error(`Google Places API: ${data.status} — ${data.error_message ?? 'sem detalhe'}`)
  }

  const result = data.result ?? {}
  const reviews = (result.reviews ?? []).slice(0, 5).map((r) => ({
    autor: r.author_name,
    foto_perfil: r.profile_photo_url ?? null,
    nota: r.rating,
    texto: r.text,
    tempo_relativo: r.relative_time_description,
  }))

  return {
    rating: result.rating ?? null,
    userRatingsTotal: result.user_ratings_total ?? null,
    reviews,
  }
}

function paraResposta(cache) {
  const { GOOGLE_PLACE_ID } = process.env
  return {
    rating: cache.rating,
    user_ratings_total: cache.user_ratings_total,
    reviews: cache.reviews ?? [],
    mapsUrl: `https://www.google.com/maps/place/?q=place_id:${GOOGLE_PLACE_ID}`,
    atualizado_em: cache.atualizado_em,
  }
}

// Busca as reviews com cache de 24h no Supabase. Se o Google falhar mas
// houver cache (mesmo vencido), devolve o cache antigo em vez de quebrar o widget.
export async function getGoogleReviews() {
  if (!googlePlacesConfigurado()) {
    throw Object.assign(new Error('Google Places não configurado'), { code: 'NOT_CONFIGURED' })
  }

  const cache = await getCache()
  const cacheFresco = cache?.atualizado_em && Date.now() - new Date(cache.atualizado_em).getTime() < CACHE_TTL_MS

  if (cacheFresco) return paraResposta(cache)

  try {
    const fresh = await fetchFromGoogle()
    await saveCache(fresh)
    return paraResposta({
      rating: fresh.rating,
      user_ratings_total: fresh.userRatingsTotal,
      reviews: fresh.reviews,
      atualizado_em: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[google-reviews] falha ao buscar da API, usando cache antigo se houver:', err.message)
    if (cache) return paraResposta(cache)
    throw err
  }
}
