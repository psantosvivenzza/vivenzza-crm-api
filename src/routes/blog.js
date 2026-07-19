import { Router } from 'express'
import axios from 'axios'
import FormData from 'form-data'
import { nuvemshopRequest } from '../lib/nuvemshop.js'
import { wordpressRequest, wordpressConfigurado } from '../lib/wordpress.js'
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
    console.error('[blog] falha ao enviar alerta WhatsApp:', err.message)
  }
}

async function registrarPublicacao({ canal, titulo, status, postUrl, erroDetalhe }) {
  const { error } = await supabase.from('publicacoes_omnichannel').insert({
    canal,
    titulo,
    status,
    post_url: postUrl ?? null,
    erro_detalhe: erroDetalhe ?? null,
  })
  if (error) console.error(`[blog/${canal}] falha ao registrar em publicacoes_omnichannel:`, error.message)
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

    await registrarPublicacao({ canal: 'nuvemshop_blog', titulo, status: 'sucesso', postUrl: null })
    res.json({ sucesso: true, post_id: post?.post_id ?? null, thumbnail_aplicada: !!thumbnailUrlFinal })
  } catch (err) {
    const detalhe = err.response?.data ?? err.message
    console.error('[blog/nuvemshop/publish] erro:', JSON.stringify(detalhe))
    await registrarPublicacao({ canal: 'nuvemshop_blog', titulo, status: 'erro', erroDetalhe: JSON.stringify(detalhe).slice(0, 2000) })
    await alertarErro(`🔴 *Falha ao publicar no blog Nuvemshop*\n\nTítulo: ${titulo}\nErro: ${String(JSON.stringify(detalhe)).slice(0, 300)}`)
    res.status(502).json({ erro: 'Falha ao publicar no blog Nuvemshop', detalhe })
  }
})

// Baixa a imagem da thumbnail_url e sobe como mídia no WordPress, devolvendo
// o ID pra usar como featured_media na criação do post.
async function uploadThumbnailWordpress(thumbnailUrl) {
  const { data: imagemBuffer, headers: imgHeaders } = await axios.get(thumbnailUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
  })

  const contentType = imgHeaders['content-type'] || 'image/jpeg'
  const extensao = contentType.split('/')[1]?.split(';')[0] || 'jpg'

  const { data } = await wordpressRequest({
    method: 'post',
    path: '/media',
    data: Buffer.from(imagemBuffer),
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="thumbnail.${extensao}"`,
    },
  })

  return data?.id ?? null
}

// POST /api/blog/wordpress/publish
router.post('/wordpress/publish', async (req, res) => {
  if (!wordpressConfigurado()) {
    return res.status(503).json({
      erro: 'WordPress ainda não configurado.',
      pendente: ['WORDPRESS_URL', 'WORDPRESS_USER', 'WORDPRESS_APP_PASSWORD'].filter((k) => !process.env[k]),
    })
  }

  const { titulo, conteudo_html, seo_title, seo_description, thumbnail_url, published } = req.body

  if (!titulo?.trim() || !conteudo_html?.trim()) {
    return res.status(400).json({ erro: 'Campos "titulo" e "conteudo_html" são obrigatórios' })
  }

  try {
    let featuredMediaId = null
    if (thumbnail_url) {
      try {
        featuredMediaId = await uploadThumbnailWordpress(thumbnail_url)
      } catch (err) {
        console.warn('[blog/wordpress/publish] falha ao subir thumbnail, publicando sem capa:', err.response?.data ?? err.message)
      }
    }

    // seo_title/seo_description via meta _yoast_wpseo_* — só tem efeito se o
    // site tiver o Yoast SEO instalado E esses campos expostos ao REST API
    // (não é padrão do WordPress; pode precisar de um filtro register_meta
    // no functions.php do tema). Sem isso, o post é criado normalmente mas
    // esses dois campos são ignorados silenciosamente pelo WordPress.
    const payload = {
      title: titulo,
      content: conteudo_html,
      status: published === false ? 'draft' : 'publish',
      ...(featuredMediaId ? { featured_media: featuredMediaId } : {}),
      ...(seo_title || seo_description
        ? {
            meta: {
              ...(seo_title ? { _yoast_wpseo_title: seo_title } : {}),
              ...(seo_description ? { _yoast_wpseo_metadesc: seo_description } : {}),
            },
          }
        : {}),
    }

    const { data: post } = await wordpressRequest({ method: 'post', path: '/posts', data: payload })

    await registrarPublicacao({ canal: 'wordpress_blog', titulo, status: 'sucesso', postUrl: post?.link ?? null })
    res.json({ sucesso: true, post_id: post?.id ?? null, url: post?.link ?? null, thumbnail_aplicada: !!featuredMediaId })
  } catch (err) {
    const detalhe = err.response?.data ?? err.message
    console.error('[blog/wordpress/publish] erro:', JSON.stringify(detalhe))
    await registrarPublicacao({ canal: 'wordpress_blog', titulo, status: 'erro', erroDetalhe: JSON.stringify(detalhe).slice(0, 2000) })
    await alertarErro(`🔴 *Falha ao publicar no blog WordPress*\n\nTítulo: ${titulo}\nErro: ${String(JSON.stringify(detalhe)).slice(0, 300)}`)
    res.status(502).json({ erro: 'Falha ao publicar no blog WordPress', detalhe })
  }
})

export default router
