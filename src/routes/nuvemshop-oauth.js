import { Router } from 'express'
import axios from 'axios'
import { saveCredentials } from '../lib/nuvemshop.js'

const router = Router()

function paginaSucesso(storeId) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Nuvemshop conectada</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f6f8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 12px; padding: 40px 48px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 420px; }
  .icone { font-size: 48px; margin-bottom: 8px; }
  h1 { font-size: 20px; color: #1a2b3c; margin: 0 0 8px; }
  p { color: #5a6b7c; font-size: 14px; margin: 0; }
  code { background: #eef1f4; padding: 2px 6px; border-radius: 4px; }
</style>
</head>
<body>
  <div class="card">
    <div class="icone">✅</div>
    <h1>Integração Nuvemshop conectada com sucesso!</h1>
    <p>Loja (store_id): <code>${storeId}</code></p>
    <p>Pode fechar esta janela.</p>
  </div>
</body>
</html>`
}

function paginaErro(mensagem) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Erro na conexão Nuvemshop</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f6f8; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 12px; padding: 40px 48px; box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; max-width: 420px; }
  .icone { font-size: 48px; margin-bottom: 8px; }
  h1 { font-size: 20px; color: #1a2b3c; margin: 0 0 8px; }
  p { color: #5a6b7c; font-size: 14px; margin: 0; }
</style>
</head>
<body>
  <div class="card">
    <div class="icone">❌</div>
    <h1>Falha ao conectar com a Nuvemshop</h1>
    <p>${mensagem}</p>
  </div>
</body>
</html>`
}

// GET /api/nuvemshop/oauth/callback — redirect_uri configurado no Portal de
// Parceiros. Troca o "code" (válido por 5 min) pelo access_token e salva no
// Supabase. Sem autenticação — é a própria Nuvemshop quem chama esta rota.
router.get('/oauth/callback', async (req, res) => {
  const { code, error: erroOAuth } = req.query

  if (erroOAuth) {
    console.error('[nuvemshop/oauth] a Nuvemshop retornou erro na autorização:', erroOAuth)
    return res.status(400).send(paginaErro(`A Nuvemshop retornou um erro: ${erroOAuth}`))
  }

  if (!code) {
    return res.status(400).send(paginaErro('Parâmetro "code" ausente na URL.'))
  }

  const { NUVEMSHOP_CLIENT_ID, NUVEMSHOP_CLIENT_SECRET } = process.env
  if (!NUVEMSHOP_CLIENT_ID || !NUVEMSHOP_CLIENT_SECRET) {
    console.error('[nuvemshop/oauth] NUVEMSHOP_CLIENT_ID/NUVEMSHOP_CLIENT_SECRET não configurados no ambiente')
    return res.status(500).send(paginaErro('Integração não configurada no servidor (client_id/client_secret ausentes).'))
  }

  try {
    const { data } = await axios.post(
      'https://www.nuvemshop.com.br/apps/authorize/token',
      {
        client_id: NUVEMSHOP_CLIENT_ID,
        client_secret: NUVEMSHOP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
    )

    const { access_token, token_type, scope, user_id } = data
    if (!access_token || !user_id) {
      throw new Error(`Resposta inesperada da Nuvemshop: ${JSON.stringify(data).slice(0, 300)}`)
    }

    await saveCredentials({ storeId: user_id, accessToken: access_token, tokenType: token_type, scope })

    console.log(`[nuvemshop/oauth] conectado com sucesso — store_id ${user_id}`)
    res.status(200).send(paginaSucesso(user_id))
  } catch (err) {
    const detalhe = err.response?.data ?? err.message
    console.error('[nuvemshop/oauth] falha ao trocar code por access_token:', JSON.stringify(detalhe))
    res.status(502).send(
      paginaErro('Falha ao trocar o código de autorização pelo token de acesso. Veja os logs do servidor para detalhes (o "code" expira em 5 minutos — pode ser que tenha expirado).')
    )
  }
})

export default router
