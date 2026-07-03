/**
 * Gerador de Refresh Token para Google Ads
 *
 * Execute UMA VEZ para obter o refresh_token OAuth2:
 *
 *   node scripts/get-refresh-token.js
 *
 * Pré-requisitos:
 *   1. Crie um projeto no Google Cloud Console
 *   2. Ative a API "Google Ads API"
 *   3. Crie credenciais OAuth2 — tipo "Web application"
 *      URI de redirecionamento autorizado: http://localhost:3000/oauth2callback
 *   4. Defina GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET no .env
 */

import 'dotenv/config'
import http from 'http'
import { URL } from 'url'
import { google } from 'googleapis'
import open from 'open'

const PORT = 3000
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`
const SCOPE = 'https://www.googleapis.com/auth/adwords'

const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  Defina GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET no .env antes de rodar.\n')
  process.exit(1)
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPE,
  prompt: 'consent',
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404)
    res.end()
    return
  }

  const code  = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<h2>❌ Autorização negada: ${error ?? 'código ausente'}</h2><p>Feche esta aba.</p>`)
    console.error(`\n❌ Autorização negada: ${error ?? 'código ausente'}\n`)
    server.close()
    process.exit(1)
  }

  try {
    const { tokens } = await oauth2Client.getToken(code)

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`
      <html><body style="font-family:sans-serif;padding:2rem">
        <h2>✅ Autorização concluída!</h2>
        <p>O <strong>refresh_token</strong> foi exibido no terminal.</p>
        <p>Feche esta aba e volte ao terminal.</p>
      </body></html>
    `)

    const line = '═'.repeat(60)
    console.log(`\n${line}`)
    console.log('  ✅  REFRESH TOKEN OBTIDO')
    console.log(line)
    console.log('\n  Adicione esta variável no Railway (Settings → Variables):\n')
    console.log(`  GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log(`\n${line}\n`)

    if (!tokens.refresh_token) {
      console.warn('  ⚠️  refresh_token não veio na resposta.')
      console.warn('  Revogue o acesso em https://myaccount.google.com/permissions')
      console.warn('  e rode o script novamente para forçar reautorização.\n')
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<h2>❌ Erro ao trocar o código</h2><pre>${err.message}</pre>`)
    console.error('\n❌ Erro ao trocar o código:', err.message)
    if (err.response?.data) console.error(err.response.data)
  }

  server.close()
})

server.listen(PORT, () => {
  console.log('\n🔐  Iniciando fluxo OAuth2 para Google Ads...')
  console.log(`    Servidor local: http://localhost:${PORT}`)
  console.log('    Abrindo navegador...\n')
  open(authUrl)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Porta ${PORT} já está em uso. Encerre o processo que a ocupa e tente novamente.\n`)
  } else {
    console.error('\n❌ Erro no servidor:', err.message)
  }
  process.exit(1)
})
