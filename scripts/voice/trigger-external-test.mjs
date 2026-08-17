// 2026-08-16 — prontidão SIP trunk externo (Nvoip): "vivenzza-external-test".
// Espelha trigger-outbound-test.mjs (ramal interno), mas exige DUAS
// condições extras antes de sequer tentar falar com o ARI:
//   voice_external_enabled=true  E  telefone em VOICE_EXTERNAL_ALLOWLIST
// Sem as duas: BLOQUEIA, nunca chega a consultar ARI/endpoint/trunk.
//
// Mesmo assim, hoje isto SEMPRE bloqueia mais cedo ainda: não há trunk/
// adapter configurado (destinoResolver.js, TRUNK_EXTERNO_CONFIGURADO=false,
// hardcoded) — rodar este script neste ambiente nunca origina uma chamada
// real, com ou sem --confirm.
//
// DRY-RUN por padrão (como o script interno). Uso:
//   node scripts/voice/trigger-external-test.mjs --numero=+55XXXXXXXXXXX            (dry-run)
//   node scripts/voice/trigger-external-test.mjs --numero=+55XXXXXXXXXXX --confirm  (originaria de verdade, se algum dia passar de todos os guards)
import axios from 'axios'
import { obterConfigCobranca } from '../../src/lib/collection/featureFlags.js'
import {
  avaliarAutorizacaoChamadaExterna, avaliarLimiteGlobalPorHora, avaliarLimiteGlobalPorDia,
} from '../../src/lib/voice/externalPilotGuardrails.js'
import { numeroNaAllowlistExterna, lerLimitesVoz } from '../../src/lib/voice/externalConfig.js'
import { idempotencyKeyLigacaoExterna } from '../../src/lib/collection/idempotency.js'
import { hojeBrtISO } from '../../src/lib/collection/collectionContactPolicy.js'
import { mascararTelefone } from '../../src/lib/telefone.js'
import { construirPayloadOriginateExterno, avaliarChamadaJaAtiva } from '../../src/lib/voice/outboundExternalTest.js'

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088'
const ARI_USER = process.env.ARI_USER
const ARI_PASSWORD = process.env.ARI_PASSWORD
const ARI_APP = process.env.ARI_APP || 'vivenzza-voice-ai'
const CONFIRMAR = process.argv.includes('--confirm')
const numeroArg = process.argv.find((a) => a.startsWith('--numero='))?.split('=')[1]

function bloquear(motivo) {
  console.error(`[external-test] BLOQUEADO: ${motivo}`)
  process.exit(1)
}

// voice_calls (migration 20260101000033) ainda não está aplicada em
// produção/local — sem tabela pra consultar "chamadas de hoje" de verdade
// ainda, os limites globais/idempotência são avaliados com histórico VAZIO
// nesta fase (documentado explicitamente no log, nunca escondido). Quando a
// migration for aplicada, trocar isto por uma consulta real a voice_calls.
async function buscarHistoricoChamadasExternas() {
  return { chamadasHoje: [], chamadasUltimaHora: [], chamadasAtivas: [], chavesJaProcessadas: [] }
}

async function main() {
  if (!numeroArg) bloquear('--numero=+55XXXXXXXXXXX é obrigatório')

  const config = await obterConfigCobranca()
  const allowlistOk = numeroNaAllowlistExterna(numeroArg)
  const limites = lerLimitesVoz()
  const { chamadasHoje, chamadasUltimaHora, chamadasAtivas, chavesJaProcessadas } = await buscarHistoricoChamadasExternas()
  console.log('[external-test] histórico de chamadas externas: tabela voice_calls ainda não aplicada — avaliando com histórico vazio nesta fase.')

  const idempotencyKey = idempotencyKeyLigacaoExterna({ contasFinanceirasId: 'external-pilot-test', diaBrt: hojeBrtISO() })

  const autorizacao = avaliarAutorizacaoChamadaExterna({
    flags: config, numero: numeroArg, allowlist: allowlistOk ? [numeroArg] : [],
    idempotencyKey, chavesJaProcessadas, chamadasAtivas,
    horaAtual: new Date(), politicaHorario: null, // fail-closed: sem política ainda, sempre bloqueia aqui — proposital
    chamadasHoje, limiteDiario: limites.maxChamadasPorTelefoneDia,
  })
  if (!autorizacao.permitido) bloquear(autorizacao.motivo)

  if (!avaliarLimiteGlobalPorHora(chamadasUltimaHora, limites.maxChamadasHora)) bloquear('limite_global_hora_excedido')
  if (!avaliarLimiteGlobalPorDia(chamadasHoje, limites.maxChamadasDia)) bloquear('limite_global_dia_excedido')

  console.log(`[external-test] guards de piloto/telefonia OK para ${mascararTelefone(numeroArg)} — seguindo pro ARI/trunk...`)

  if (!ARI_USER || !ARI_PASSWORD) bloquear('ARI_USER/ARI_PASSWORD não configurados no ambiente')
  const cliente = axios.create({ baseURL: `${ARI_URL}/ari`, auth: { username: ARI_USER, password: ARI_PASSWORD }, timeout: 5000 })

  let payload
  try {
    payload = construirPayloadOriginateExterno({ numero: numeroArg, ariApp: ARI_APP })
  } catch (err) {
    // Esperado hoje: destinoResolver.js sempre lança pra EXTERNAL (sem
    // trunk configurado) — este é o comportamento CORRETO, não um bug.
    bloquear(`sem_trunk: ${err.message}`)
  }

  console.log('[external-test] payload validado:', JSON.stringify(payload))
  if (!CONFIRMAR) {
    console.log('[external-test] DRY RUN — não originei nada. (Nunca chegaria aqui sem --confirm de qualquer forma.)')
    process.exit(0)
  }

  console.log('[external-test] verificando ARI...')
  try {
    await cliente.get('/asterisk/info')
  } catch (err) {
    bloquear(`ARI inalcançável em ${ARI_URL}: ${err.message}`)
  }

  const { data: canais } = await cliente.get('/channels').catch((err) => bloquear(`não consegui listar canais ativos: ${err.message}`))
  if (avaliarChamadaJaAtiva(canais)) bloquear(`já existe(m) ${canais.length} canal(is) ativo(s) — encerre antes de originar`)

  console.log('[external-test] ORIGINANDO chamada externa real para', mascararTelefone(numeroArg), '...')
  try {
    const { data } = await cliente.post('/channels', payload)
    console.log(`[external-test] OUTBOUND_CREATED channel_id=${data.id}`)
  } catch (err) {
    bloquear(`falha ao originar: ${err.response?.data?.message || err.message}`)
  }
}

main()
