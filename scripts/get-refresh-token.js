/**
 * Gerador de Refresh Token para Google Ads (fluxo OOB)
 *
 * Execute UMA VEZ para obter o refresh_token OAuth2:
 *
 *   node scripts/get-refresh-token.js
 *
 * Pré-requisitos:
 *   1. Crie um projeto no Google Cloud Console
 *   2. Ative a API "Google Ads API"
 *   3. Crie credenciais OAuth2 — tipo "Desktop app"
 *   4. Defina GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET no .env
 */

import 'dotenv/config'
import readline from 'readline'
import { google } from 'googleapis'

const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('\n❌  Defina GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET no .env antes de rodar.\n')
  process.exit(1)
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'
)

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: 'https://www.googleapis.com/auth/adwords',
  prompt: 'consent',
})

const line = '═'.repeat(60)

console.log(`\n${line}`)
console.log('  🔐  AUTORIZAÇÃO GOOGLE ADS')
console.log(line)
console.log('\n  1. Abra esta URL no navegador:\n')
console.log(`  ${authUrl}`)
console.log('\n  2. Faça login com a conta que tem acesso ao Google Ads')
console.log('  3. Autorize o acesso')
console.log('  4. Copie o código exibido pelo Google e cole abaixo\n')
console.log(line)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

rl.question('\n  Código de autorização: ', async (code) => {
  rl.close()

  if (!code.trim()) {
    console.error('\n❌  Nenhum código informado.\n')
    process.exit(1)
  }

  try {
    const { tokens } = await oauth2Client.getToken(code.trim())

    if (!tokens.refresh_token) {
      console.warn(`\n${line}`)
      console.warn('  ⚠️  refresh_token não veio na resposta.')
      console.warn('  Revogue o acesso em https://myaccount.google.com/permissions')
      console.warn('  e rode o script novamente para forçar nova autorização.')
      console.warn(`${line}\n`)
      process.exit(1)
    }

    console.log(`\n${line}`)
    console.log('  ✅  REFRESH TOKEN OBTIDO')
    console.log(line)
    console.log('\n  Adicione esta variável no Railway (Settings → Variables):\n')
    console.log(`  GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}`)
    console.log(`\n${line}\n`)
  } catch (err) {
    console.error('\n❌  Erro ao trocar o código:', err.message)
    if (err.response?.data) console.error(err.response.data)
    process.exit(1)
  }
})
