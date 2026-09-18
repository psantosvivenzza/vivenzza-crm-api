// 2026-08-16 — prontidão SIP trunk externo (Nvoip): "vivenzza-external-test".
// Espelha trigger-outbound-test.mjs (ramal interno), mas exige DUAS
// condições extras antes de sequer tentar falar com o ARI:
//   voice_external_enabled=true  E  telefone em VOICE_EXTERNAL_ALLOWLIST
// Sem as duas: BLOQUEIA, nunca chega a consultar ARI/endpoint/trunk.
//
// ATUALIZADO 2026-09-16: TRUNK_EXTERNO_CONFIGURADO agora e true
// (destinoResolver.js) — credenciais Nvoip reais compradas (numero
// 555121651117), adapter de dial-string implementado. AINDA ASSIM este
// script so origina de verdade se TODAS as travas abaixo passarem:
//   1. voice_external_enabled=true no banco (SQL direto, sem rota PATCH)
//   2. telefone presente em VOICE_EXTERNAL_ALLOWLIST
//   3. endpoint [nvoip-endpoint] aplicado E registrado de verdade no
//      Asterisk real (WSL2) — sem isso o originate falha no ARI mesmo
//      com --confirm
// Nenhuma das 3 foi feita ainda — ver docs/cobranca-ai/NVOIP_HOMOLOGACAO.md
// (passos 1-16, nenhum executado). Nao rodar --confirm sem seguir esse
// roteiro passo a passo, com o operador ouvindo o audio real.
//
// DRY-RUN por padrão (como o script interno). Uso:
//   node scripts/voice/trigger-external-test.mjs --numero=+55XXXXXXXXXXX            (dry-run)
//   node scripts/voice/trigger-external-test.mjs --numero=+55XXXXXXXXXXX --confirm  (originaria de verdade, se algum dia passar de todos os guards)
import 'dotenv/config'
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
import { buscarEstadoChamadasExternas, registrarTentativa } from '../../src/lib/voice/voiceCallsRepo.js'
import { avaliarProximaTentativa, faixaDoHorario } from '../../src/lib/voice/reguaTentativas.js'

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088'
const ARI_USER = process.env.ARI_USER
const ARI_PASSWORD = process.env.ARI_PASSWORD
const ARI_APP = process.env.ARI_APP || 'vivenzza-voice-ai'
const CONFIRMAR = process.argv.includes('--confirm')
// --teste-proprio: dispensa a régua de cadência e o teto por telefone SOMENTE
// para números da VOICE_EXTERNAL_ALLOWLIST — na prática, o celular do próprio
// dono. Existe porque a régua (correta para cliente) trava o telefone de teste
// em 1 ligação por dia, o que impede validar o sistema. TODOS os outros guards
// continuam valendo: janela legal, flag do banco, trunk, teto global por
// hora/dia e o registro em voice_calls.
const TESTE_PROPRIO = process.argv.includes('--teste-proprio')
const numeroArg = process.argv.find((a) => a.startsWith('--numero='))?.split('=')[1]

function bloquear(motivo) {
  console.error(`[external-test] BLOQUEADO: ${motivo}`)
  process.exitCode = 1
}

// 2026-09-17 — migration voice_calls APLICADA. O stub que devolvia histórico
// vazio (e que, na prática, desligava TODOS os limites: por hora, por dia e
// por telefone) foi substituído pela consulta real. Se a leitura falhar, o
// repositório lança — nunca degrada para "histórico vazio", que foi
// exatamente o modo de falha anterior.

async function main() {
  if (!numeroArg) return bloquear('--numero=+55XXXXXXXXXXX é obrigatório')

  const config = await obterConfigCobranca()
  const allowlistOk = numeroNaAllowlistExterna(numeroArg)
  const limites = lerLimitesVoz()
  let estado
  try {
    estado = await buscarEstadoChamadasExternas({ numero: numeroArg })
  } catch (err) {
    return bloquear(`nao_consegui_ler_historico: ${err.message} (fail-closed — nunca ligo sem saber quantas vezes já liguei)`)
  }
  const { chamadasHoje, chamadasUltimaHora, chamadasAtivas, chavesJaProcessadas, historicoTelefone } = estado
  console.log(`[external-test] histórico real: ${chamadasHoje.length} chamada(s) hoje, ${chamadasUltimaHora.length} na última hora, ${historicoTelefone.length} para este telefone no ciclo.`)

  // Régua de 10 tentativas: espaçamento, rotação de faixa de horário, trava
  // de 7 dias após contato efetivo e trava até a data prometida.
  const regua = avaliarProximaTentativa({ historico: historicoTelefone, agora: new Date() })
  if (!regua.permitido) {
    if (!(TESTE_PROPRIO && allowlistOk)) return bloquear(`regua: ${regua.motivo}`)
    console.log(`[external-test] TESTE PRÓPRIO — régua dispensada ("${regua.motivo}") porque o número está na allowlist. Nunca vale para cliente.`)
  }
  console.log(`[external-test] régua OK — tentativa ${regua.tentativaNumero}/10 do ciclo iniciado em ${regua.cicloIniciadoEm}, faixa ${regua.faixaHorario}.`)

  // Em teste próprio a chave leva o horário: a idempotência existe pra impedir
  // duas cobranças da MESMA conta no mesmo dia (regra certa pra cliente), e não
  // pra impedir o dono de testar o sistema duas vezes seguidas no próprio celular.
  const idempotencyKey = TESTE_PROPRIO
    ? idempotencyKeyLigacaoExterna({ contasFinanceirasId: `teste-proprio-${Date.now()}`, diaBrt: hojeBrtISO() })
    : idempotencyKeyLigacaoExterna({ contasFinanceirasId: 'external-pilot-test', diaBrt: hojeBrtISO() })

  const autorizacao = avaliarAutorizacaoChamadaExterna({
    flags: config, numero: numeroArg, allowlist: allowlistOk ? [numeroArg] : [],
    idempotencyKey, chavesJaProcessadas, chamadasAtivas,
    horaAtual: new Date(),
    // 2026-09-16: janela baseada na Lei estadual RS 15.608/2014 (mais
    // restritiva que a regra federal SARB 27/2023 e que qualquer outro
    // estado levantado) — seg-sex 08:00-18:50, sem sabado/domingo. Aqui
    // usamos 08:00-18:40 (10min de margem de seguranca antes do limite
    // legal). Usada como padrao NACIONAL conservador ate existir volume
    // real de ligacoes pra construir escala por estado/taxa de resposta.
    // Nao e mais fail-closed cego — mas continua fail-closed fora dessa
    // janela.
    politicaHorario: { janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 8 * 60, fimMinutos: 18 * 60 + 40 }] },
    chamadasHoje, limiteDiario: limites.maxChamadasPorTelefoneDia,
  })
  if (!autorizacao.permitido) {
    const soLimitePorTelefone = autorizacao.motivo?.startsWith('limite_diario_excedido')
    if (!(TESTE_PROPRIO && allowlistOk && soLimitePorTelefone)) return bloquear(autorizacao.motivo)
    console.log('[external-test] TESTE PRÓPRIO — teto por telefone dispensado (número na allowlist).')
  }

  // Os tetos globais por hora/dia existem para proteger o NUMERO DE ORIGEM:
  // operadora marca como spam por volume, nao por destino. Mas ligacao de
  // teste para o proprio numero do dono (allowlist) nao pode consumir a cota
  // dos clientes -- senao calibrar a voz gasta o orcamento de cobranca do
  // dia, que foi exatamente o que aconteceu em 17/09/2026. Continua havendo
  // teto para o teste, so que uma conta separada e menor.
  const MAX_TESTE_PROPRIO_HORA = Number(process.env.VOICE_MAX_TESTE_PROPRIO_HORA || 15)
  const dispensaGlobal = TESTE_PROPRIO && allowlistOk
  if (dispensaGlobal) {
    if (chamadasUltimaHora.length >= MAX_TESTE_PROPRIO_HORA) {
      return bloquear(`limite_teste_proprio_hora_excedido: ${chamadasUltimaHora.length}/${MAX_TESTE_PROPRIO_HORA}`)
    }
    console.log(`[external-test] TESTE PRÓPRIO — tetos globais dispensados (${chamadasUltimaHora.length}/${MAX_TESTE_PROPRIO_HORA} na hora). Nunca vale para cliente.`)
  } else {
    if (!avaliarLimiteGlobalPorHora(chamadasUltimaHora, limites.maxChamadasHora)) return bloquear('limite_global_hora_excedido')
    if (!avaliarLimiteGlobalPorDia(chamadasHoje, limites.maxChamadasDia)) return bloquear('limite_global_dia_excedido')
  }

  console.log(`[external-test] guards de piloto/telefonia OK para ${mascararTelefone(numeroArg)} — seguindo pro ARI/trunk...`)

  if (!ARI_USER || !ARI_PASSWORD) return bloquear('ARI_USER/ARI_PASSWORD não configurados no ambiente')
  const cliente = axios.create({ baseURL: `${ARI_URL}/ari`, auth: { username: ARI_USER, password: ARI_PASSWORD }, timeout: 5000 })

  let payload
  try {
    payload = construirPayloadOriginateExterno({ numero: numeroArg, ariApp: ARI_APP, clienteNome: (process.argv.find((a) => a.startsWith('--nome=')) || '').split('=')[1] || null })
  } catch (err) {
    // Esperado hoje: destinoResolver.js sempre lança pra EXTERNAL (sem
    // trunk configurado) — este é o comportamento CORRETO, não um bug.
    return bloquear(`sem_trunk: ${err.message}`)
  }

  console.log('[external-test] payload validado:', JSON.stringify(payload))
  if (!CONFIRMAR) {
    console.log('[external-test] DRY RUN — não originei nada. (Nunca chegaria aqui sem --confirm de qualquer forma.)')
    process.exitCode = 0
    return
  }

  console.log('[external-test] verificando ARI...')
  try {
    await cliente.get('/asterisk/info')
  } catch (err) {
    return bloquear(`ARI inalcançável em ${ARI_URL}: ${err.message}`)
  }

  let canais
  try {
    ({ data: canais } = await cliente.get('/channels'))
  } catch (err) {
    return bloquear(`não consegui listar canais ativos: ${err.message}`)
  }
  if (avaliarChamadaJaAtiva(canais)) return bloquear(`já existe(m) ${canais.length} canal(is) ativo(s) — encerre antes de originar`)

  console.log('[external-test] ORIGINANDO chamada externa real para', mascararTelefone(numeroArg), '...')
  const contexto = {
    numero: numeroArg,
    destinationMasked: mascararTelefone(numeroArg),
    idempotencyKey,
    tentativaNumero: regua.tentativaNumero ?? (historicoTelefone.length + 1),
    cicloIniciadoEm: regua.cicloIniciadoEm ?? hojeBrtISO(),
    faixaHorario: regua.faixaHorario ?? faixaDoHorario(new Date()),
    numeroOrigem: process.env.NVOIP_CALLER_ID || null,
    campanha: 'EXTERNAL_PILOT_TEST',
  }
  try {
    const { data } = await cliente.post('/channels', payload)
    console.log(`[external-test] OUTBOUND_CREATED channel_id=${data.id}`)
    // Grava DEPOIS de ter o call_id do Asterisk — é ele que amarra este
    // registro aos eventos de atendimento/desligamento que o serviço de voz
    // vai escrever depois.
    await registrarTentativa({ ...contexto, callId: data.id, status: 'CREATED' })
  } catch (err) {
    // Tentativa que nem saiu TAMBÉM entra no histórico: é esse número que
    // denuncia bloqueio de operadora (muito volume, pouca completação).
    const motivo = err.response?.data?.message || err.message
    try {
      await registrarTentativa({
        ...contexto,
        callId: `falha-${idempotencyKey}-${Date.now()}`,
        status: 'FAILED',
        failureClass: 'ORIGINATE_FAILED',
        hangupCause: motivo,
      })
    } catch (erroRegistro) {
      console.error(`[external-test] ATENÇÃO: falhei em registrar a tentativa falha — ${erroRegistro.message}`)
    }
    return bloquear(`falha ao originar: ${motivo}`)
  }
}

main()
