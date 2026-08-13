// Voice AI — VOICE AI OUTBOUND INTERNAL MVP. Dispara UMA chamada de teste
// pra PJSIP/7001 via REST puro do ARI (não precisa da conexão WebSocket —
// essa já está ativa no processo `npm run voice:service`, que vai receber
// o StasisStart resultante automaticamente e conduzir a conversa com o
// MESMO cérebro/loop já homologado — ver ariCallService.js).
//
// Roda em modo DRY-RUN por padrão: valida tudo (ARI alcançável, endpoint
// online, nenhuma chamada já ativa) mas NÃO origina. Só origina de fato
// com a flag --confirm — dupla trava deliberada além da autorização
// humana na conversa.
//
// Uso:
//   node scripts/voice/trigger-outbound-test.mjs            (dry-run)
//   node scripts/voice/trigger-outbound-test.mjs --confirm  (origina de verdade)
import axios from 'axios'
import { construirPayloadOriginate, avaliarChamadaJaAtiva, avaliarEndpointOnline, ENDPOINT_PERMITIDO } from '../../src/lib/voice/outboundInternalTest.js'

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088'
const ARI_USER = process.env.ARI_USER
const ARI_PASSWORD = process.env.ARI_PASSWORD
const ARI_APP = process.env.ARI_APP || 'vivenzza-voice-ai'
const CONFIRMAR = process.argv.includes('--confirm')

function bloquear(motivo) {
  console.error(`[outbound-test] BLOQUEADO: ${motivo}`)
  process.exit(1)
}

async function main() {
  if (!ARI_USER || !ARI_PASSWORD) bloquear('ARI_USER/ARI_PASSWORD não configurados no ambiente')

  const cliente = axios.create({ baseURL: `${ARI_URL}/ari`, auth: { username: ARI_USER, password: ARI_PASSWORD }, timeout: 5000 })

  console.log('[outbound-test] verificando ARI...')
  try {
    await cliente.get('/asterisk/info')
  } catch (err) {
    bloquear(`ARI inalcançável em ${ARI_URL}: ${err.message}`)
  }
  console.log('[outbound-test] ARI OK')

  console.log(`[outbound-test] verificando endpoint ${ENDPOINT_PERMITIDO}...`)
  let endpointInfo
  try {
    const { data } = await cliente.get(`/endpoints/${ENDPOINT_PERMITIDO}`)
    endpointInfo = data
  } catch (err) {
    bloquear(`não consegui consultar o endpoint ${ENDPOINT_PERMITIDO}: ${err.message}`)
  }
  if (!avaliarEndpointOnline(endpointInfo)) bloquear(`endpoint ${ENDPOINT_PERMITIDO} não está online (state=${endpointInfo?.state}) — MicroSIP precisa estar registrado`)
  console.log(`[outbound-test] endpoint ${ENDPOINT_PERMITIDO} online`)

  console.log('[outbound-test] verificando chamadas já ativas...')
  let canais
  try {
    const { data } = await cliente.get('/channels')
    canais = data
  } catch (err) {
    bloquear(`não consegui listar canais ativos: ${err.message}`)
  }
  if (avaliarChamadaJaAtiva(canais)) bloquear(`já existe(m) ${canais.length} canal(is) ativo(s) neste Asterisk — encerre antes de originar um novo teste`)
  console.log('[outbound-test] nenhuma chamada ativa — livre pra originar')

  const payload = construirPayloadOriginate(ARI_APP)
  console.log('[outbound-test] payload validado:', JSON.stringify(payload))

  if (!CONFIRMAR) {
    console.log('[outbound-test] DRY RUN — tudo validado, mas NÃO originei nada. Rode com --confirm pra originar de fato.')
    process.exit(0)
  }

  console.log('[outbound-test] ORIGINANDO chamada real para', ENDPOINT_PERMITIDO, '...')
  try {
    const { data } = await cliente.post('/channels', payload)
    console.log(`[outbound-test] OUTBOUND_CREATED channel_id=${data.id} name=${data.name}`)
    console.log('[outbound-test] o telefone (MicroSIP) deve tocar agora. Acompanhe o log do voice:service pro restante da chamada.')
  } catch (err) {
    bloquear(`falha ao originar: ${err.response?.data?.message || err.message}`)
  }
}

main()
