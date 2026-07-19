import { Router } from 'express'
import axios from 'axios'
import FormData from 'form-data'
import { nuvemshopRequest } from '../lib/nuvemshop.js'
import { supabase } from '../lib/supabase.js'

const router = Router()

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const ALERTA_NUMERO = '555131372313'

async function alertarErro(mensagem) {
  try {
    await axios.post(
      `${EVOLUTION_URL}/message/sendText/${INSTANCE}`,
      { number: ALERTA_NUMERO, text: mensagem },
      { headers: { apikey: EVOLUTION_KEY }, timeout: 15000 }
    )
  } catch (err) {
    console.error('[blog/nuvemshop] falha ao enviar alerta WhatsApp:', err.message)
  }
}

async function registrarPublicacao({ titulo, status, postUrl, erroDetalhe }) {
  const { error } = await supabase.from('publicacoes_omnichannel').insert({
    canal: 'nuvemshop_blog',
    titulo,
    status,
    post_url: postUrl ?? null,
    erro_detalhe: erroDetalhe ?? null,
  })
  if (error) console.error('[blog/nuvemshop] falha ao registrar em publicacoes_omnichannel:', error.message)
}

// A loja tem um único blog — cacheia o blog_id em memória do processo.
let _cachedBlogId = null
async function getBlogId() {
  if (_cachedBlogId) return _cachedBlogId
  const { data } = await nuvemshopRequest({ method: 'get', path: '/blogs' })
  const blog = Array.isArray(data) ? data[0] : data
  const blogId = blog?.blog_id ?? blog?.id
  if (!blogId) throw new Error('Nenhum blog encontrado na loja Nuvemshop')
  _cachedBlogId = blogId
  return _cachedBlogId
}

// Baixa a imagem da thumbnail_url e sobe via endpoint dedicado, que devolve
// a URL final da Nuvemshop a ser usada na criação do post.
async function uploadThumbnail(blogId, thumbnailUrl) {
  const { data: imagemBuffer, headers: imgHeaders } = await axios.get(thumbnailUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
  })

  const form = new FormData()
  form.append('image', Buffer.from(imagemBuffer), {
    filename: 'thumbnail.jpg',
    contentType: imgHeaders['content-type'] || 'image/jpeg',
  })

  const { data } = await nuvemshopRequest({
    method: 'post',
    path: `/blogs/${blogId}/posts/thumbnail`,
    data: form,
    headers: form.getHeaders(),
  })

  return data?.thumbnail_url ?? null
}

// POST /api/blog/nuvemshop/publish
router.post('/nuvemshop/publish', async (req, res) => {
  const { titulo, conteudo_html, seo_title, seo_description, thumbnail_url, published } = req.body

  if (!titulo?.trim() || !conteudo_html?.trim()) {
    return res.status(400).json({ erro: 'Campos "titulo" e "conteudo_html" são obrigatórios' })
  }

  try {
    const blogId = await getBlogId()

    let thumbnailUrlFinal = null
    if (thumbnail_url) {
      try {
        thumbnailUrlFinal = await uploadThumbnail(blogId, thumbnail_url)
      } catch (err) {
        console.warn('[blog/nuvemshop/publish] falha ao subir thumbnail, publicando sem capa:', err.response?.data ?? err.message)
      }
    }

    const metadata = {
      language: 'pt',
      title: titulo,
      ...(seo_title ? { seo_title } : {}),
      ...(seo_description ? { seo_description } : {}),
    }

    const form = new FormData()
    form.append('metadata', JSON.stringify(metadata))
    form.append('content', conteudo_html)
    form.append('published', String(!!published))
    if (thumbnailUrlFinal) form.append('thumbnail', thumbnailUrlFinal)

    const { data: post } = await nuvemshopRequest({
      method: 'post',
      path: `/blogs/${blogId}/posts`,
      data: form,
      headers: form.getHeaders(),
    })

    await registrarPublicacao({ titulo, status: 'sucesso', postUrl: null })
    res.json({ sucesso: true, post_id: post?.post_id ?? null, thumbnail_aplicada: !!thumbnailUrlFinal })
  } catch (err) {
    const detalhe = err.response?.data ?? err.message
    console.error('[blog/nuvemshop/publish] erro:', JSON.stringify(detalhe))
    await registrarPublicacao({ titulo, status: 'erro', erroDetalhe: JSON.stringify(detalhe).slice(0, 2000) })
    await alertarErro(`🔴 *Falha ao publicar no blog Nuvemshop*\n\nTítulo: ${titulo}\nErro: ${String(JSON.stringify(detalhe)).slice(0, 300)}`)
    res.status(502).json({ erro: 'Falha ao publicar no blog Nuvemshop', detalhe })
  }
})

export default router
