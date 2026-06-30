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
 *   3. Crie credenciais OAuth2 do tipo "Desktop app"
 *   4. Defina as variáveis abaixo (ou .env) antes de rodar
 *
 * Após rodar:
 *   - O script abre uma URL no console
 *   - Faça login com a conta Google Ads (ou MCC)
 *   - Cole o código de autorização de volta no terminal
 *   - O refresh_token será exibido — copie para GOOGLE_ADS_REFRESH_TOKEN
 */

import 'dotenv/config'
import { google } from 'googleapis'
import readline from 'readline'

const CLIENT_ID     = process.env.GOOGLE_ADS_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Defina GOOGLE_ADS_CLIENT_ID e GOOGLE_ADS_CLIENT_SECRET no .env antes de rodar este script.')
  process.exit(1)
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob'  // redirect para "copiar e colar" — sem servidor local necessário
)

const SCOPES = ['https://www.googleapis.com/auth/adwords']

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',  // força emissão de refresh_token mesmo se já autorizado
})

console.log('\n=== AUTORIZAÇÃO GOOGLE ADS ===\n')
console.log('1. Abra esta URL no navegador:\n')
console.log(authUrl)
console.log('\n2. Faça login com a conta que tem acesso ao Google Ads / MCC')
console.log('3. Cole o código de autorização abaixo:\n')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

rl.question('Código de autorização: ', async (code) => {
  rl.close()
  try {
    const { tokens } = await oauth2Client.getToken(code.trim())
    console.log('\n=== CREDENCIAIS OBTIDAS ===\n')
    console.log('Adicione ao Railway (ou .env):\n')
    console.log(`GOOGLE_ADS_REFRESH_TOKEN=${tokens.refresh_token}`)
    if (tokens.access_token) {
      console.log(`\n(access_token temporário, não salvar: ${tokens.access_token.slice(0, 20)}...)`)
    }
    console.log('\n✅ Pronto. Reinicie o servidor após definir a variável.')
  } catch (err) {
    console.error('\n❌ Erro ao trocar o código:', err.message)
    if (err.response?.data) console.error(err.response.data)
    process.exit(1)
  }
})
