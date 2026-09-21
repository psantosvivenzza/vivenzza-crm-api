// Disparador da fila de cobrança por voz.
//
// Uso:
//   node scripts/voice/rodar-fila-cobranca.mjs                  (dry-run, mostra a fila)
//   node scripts/voice/rodar-fila-cobranca.mjs --limite=5 --confirm   (liga de verdade)
//
// AUTORIZAÇÃO: a FILA (vw_fila_ligacao_cobranca) é a fonte de ELEGIBILIDADE —
// ela já aplica, no banco: título realmente vencido, fora de revisão,
// WhatsApp enviado há mais de 2 dias, cliente não respondeu, sem promessa em
// aberto, sem trava pós-contato, ciclo não esgotado e nenhuma ligação hoje.
// Um número que não está na fila com motivo_bloqueio NULL nunca é discado
// por este script.
//
// ACHADO DA AUDITORIA (f8cb81c9, 2026-09-21): a versão anterior deste script
// montava, para cada item, uma allowlist de um único elemento contendo o
// PRÓPRIO número da fila — que virava, sozinho, a allowlist usada por
// avaliarAutorizacaoChamadaExterna(), o que fazia avaliarNumeroNaAllowlist()
// devolver sempre true e desativava, na prática,
// o gate de allowlist inteiro (elegibilidade na fila bastava pra "autorizar"
// a si mesma). CORRIGIDO: a fila continua sendo a fonte de ELEGIBILIDADE,
// mas a ALLOWLIST usada na autorização é sempre a externa/configurada
// (VOICE_EXTERNAL_ALLOWLIST, mesma fonte usada por trigger-external-test.mjs)
// — a fila NUNCA autoautoriza o próprio destinatário. Fail-closed: allowlist
// ausente, vazia, malformada, ou qualquer erro ao lê-la/comparar bloqueia
// ANTES de qualquer tentativa de originar (ver resolverAllowlistParaAutorizacao
// abaixo).
//
// Além disso, TODOS os guards de reguaTentativas.js e externalPilotGuardrails.js
// continuam rodando por telefone, e o limite global por hora/dia continua valendo.
import 'dotenv/config'
import axios from 'axios'
import { pathToFileURL } from 'url'
import { supabase } from '../../src/lib/collection/../supabase-admin.server.js'
import { obterConfigCobranca } from '../../src/lib/collection/featureFlags.js'
import {
  avaliarAutorizacaoChamadaExterna,
  avaliarLimiteGlobalPorHora,
  avaliarLimiteGlobalPorDia,
} from '../../src/lib/voice/externalPilotGuardrails.js'
import { lerLimitesVoz, numeroNaAllowlistExterna } from '../../src/lib/voice/externalConfig.js'
import { idempotencyKeyLigacaoExterna } from '../../src/lib/collection/idempotency.js'
import { hojeBrtISO } from '../../src/lib/collection/collectionContactPolicy.js'
import { mascararTelefone } from '../../src/lib/telefone.js'
import { construirPayloadOriginateExterno, validarTelefoneBrasileiro } from '../../src/lib/voice/outboundExternalTest.js'
import { buscarEstadoChamadasExternas, registrarTentativa } from '../../src/lib/voice/voiceCallsRepo.js'
import { avaliarProximaTentativa } from '../../src/lib/voice/reguaTentativas.js'

const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088'
const ARI_USER = process.env.ARI_USER
const ARI_PASSWORD = process.env.ARI_PASSWORD
const ARI_APP = process.env.ARI_APP || 'vivenzza-voice-ai'

const CONFIRMAR = process.argv.includes('--confirm')
const LIMITE = Number(process.argv.find((a) => a.startsWith('--limite='))?.split('=')[1] ?? 5)
const PAUSA_MS = Number(process.argv.find((a) => a.startsWith('--pausa='))?.split('=')[1] ?? 45000)
// Teto de espera por uma ligação: 4 turnos x (10s de gravação + ~25s de
// STT/LLM/TTS) + saudação. Passou disto, algo travou e seguimos em frente.
const ESPERA_MAXIMA_CHAMADA_MS = Number(process.env.VOICE_ESPERA_MAXIMA_CHAMADA_MS || 210000)

const POLITICA_HORARIO = {
  // Lei estadual RS 15.608/2014, a mais restritiva do levantamento, usada como
  // padrão nacional conservador. 18:40 dá 10min de margem antes do limite legal.
  janelas: [{ dias: [1, 2, 3, 4, 5], inicioMinutos: 8 * 60, fimMinutos: 18 * 60 + 40 }],
}

function log(msg) { console.log(`[fila-cobranca] ${msg}`) }

// Único ponto de decisão de allowlist do dispatcher automático — exportado
// pra ser testável sem depender de Supabase/ARI (main() nunca é chamado ao
// importar este módulo, ver isMain no fim do arquivo). NUNCA usa `numero`
// como fonte da allowlist — só a externa/configurada. `verificarNaAllowlist`
// é injetável só para teste (erro de leitura/comparação); em produção é
// sempre numeroNaAllowlistExterna (env VOICE_EXTERNAL_ALLOWLIST).
export function resolverAllowlistParaAutorizacao(numero, verificarNaAllowlist = numeroNaAllowlistExterna) {
  try {
    return { allowlist: verificarNaAllowlist(numero) ? [numero] : [], erro: null }
  } catch (err) {
    return { allowlist: [], erro: `erro_leitura_allowlist: ${err.message}` }
  }
}

async function main() {
  const config = await obterConfigCobranca()
  const limites = lerLimitesVoz()

  const { data: fila, error } = await supabase
    .from('vw_fila_ligacao_cobranca')
    .select('codigo_cliente, cliente, telefone, telefone_mascarado, titulos, valor_total, dias_atraso_max, faixa, prioridade')
    .is('motivo_bloqueio', null)
    .order('prioridade', { ascending: true })
    .order('valor_total', { ascending: false })
    .limit(LIMITE)

  if (error) {
    console.error(`[fila-cobranca] ERRO ao ler a fila: ${error.message}`)
    process.exitCode = 1
    return
  }
  if (!fila?.length) {
    log('fila vazia - ninguém elegível agora. Nada a fazer.')
    return
  }

  log(`${fila.length} cliente(s) na fila (limite ${LIMITE}):`)
  for (const c of fila) {
    log(`   [${c.faixa}] ${c.cliente} - ${c.telefone_mascarado} - R$ ${c.valor_total} (${c.titulos} título(s), ${c.dias_atraso_max}d)`)
  }

  if (!CONFIRMAR) {
    log('')
    log('DRY RUN - nenhuma ligação foi feita. Use --confirm para discar de verdade.')
    return
  }

  if (!ARI_USER || !ARI_PASSWORD) {
    console.error('[fila-cobranca] ARI_USER/ARI_PASSWORD não configurados')
    process.exitCode = 1
    return
  }
  const cliente = axios.create({
    baseURL: `${ARI_URL}/ari`,
    auth: { username: ARI_USER, password: ARI_PASSWORD },
    timeout: 5000,
  })
  try {
    await cliente.get('/asterisk/info')
  } catch (err) {
    console.error(`[fila-cobranca] ARI inalcançável em ${ARI_URL}: ${err.message}`)
    process.exitCode = 1
    return
  }

  let discadas = 0
  let ultimoCanalId = null
  let bloqueadas = 0

  for (const c of fila) {
    const numero = c.telefone
    const rotulo = `${c.cliente} (${mascararTelefone(numero)})`

    let estado
    try {
      estado = await buscarEstadoChamadasExternas({ numero })
    } catch (err) {
      log(`PULADO ${rotulo}: não consegui ler o histórico - ${err.message}`)
      bloqueadas++
      continue
    }

    const idempotencyKey = idempotencyKeyLigacaoExterna({
      contasFinanceirasId: c.codigo_cliente,
      diaBrt: hojeBrtISO(),
    })

    // A fila é a fonte de ELEGIBILIDADE; a allowlist é sempre a
    // externa/configurada — nunca o próprio número (ver cabeçalho, achado
    // f8cb81c9). Erro/ausência/vazio/malformado bloqueia ANTES de qualquer
    // tentativa de originar.
    const { allowlist, erro: erroAllowlist } = resolverAllowlistParaAutorizacao(numero)
    if (erroAllowlist) {
      log(`BLOQUEADO ${rotulo}: ${erroAllowlist}`)
      bloqueadas++
      continue
    }

    const autorizacao = avaliarAutorizacaoChamadaExterna({
      flags: config,
      numero,
      allowlist,
      idempotencyKey,
      chavesJaProcessadas: estado.chavesJaProcessadas,
      chamadasAtivas: estado.chamadasAtivas,
      horaAtual: new Date(),
      politicaHorario: POLITICA_HORARIO,
      chamadasHoje: estado.chamadasHoje,
      limiteDiario: limites.maxChamadasPorTelefoneDia,
    })
    if (!autorizacao.permitido) {
      log(`BLOQUEADO ${rotulo}: ${autorizacao.motivo}`)
      bloqueadas++
      continue
    }

    if (!avaliarLimiteGlobalPorHora(estado.chamadasUltimaHora, limites.maxChamadasHora)) {
      log(`PARANDO: teto de ${limites.maxChamadasHora} ligações/hora atingido. Rode de novo mais tarde.`)
      break
    }
    if (!avaliarLimiteGlobalPorDia(estado.chamadasHoje, limites.maxChamadasDia)) {
      log(`PARANDO: teto de ${limites.maxChamadasDia} ligações/dia atingido.`)
      break
    }

    // Valida ANTES de qualquer coisa. Número malformado numa cobrança é
    // ligação para um terceiro aleatório falando de conta em atraso.
    const validacao = validarTelefoneBrasileiro(numero)
    if (!validacao.valido) {
      log(`BLOQUEADO ${rotulo}: ${validacao.motivo} — cadastro precisa de correção humana`)
      bloqueadas++
      continue
    }

    const regua = avaliarProximaTentativa({ historico: estado.historicoTelefone, agora: new Date() })
    if (!regua.permitido) {
      log(`BLOQUEADO ${rotulo}: régua - ${regua.motivo}`)
      bloqueadas++
      continue
    }

    const contexto = {
      numero,
      destinationMasked: mascararTelefone(numero),
      idempotencyKey,
      codigoCliente: c.codigo_cliente,
      clienteNome: c.cliente,
      tentativaNumero: regua.tentativaNumero,
      cicloIniciadoEm: regua.cicloIniciadoEm,
      faixaHorario: regua.faixaHorario,
      numeroOrigem: process.env.NVOIP_CALLER_ID || null,
      campanha: 'COBRANCA_FILA',
    }

    try {
      const payload = construirPayloadOriginateExterno({ numero, ariApp: ARI_APP, clienteNome: c.cliente })
      const { data } = await cliente.post('/channels', payload)
      await registrarTentativa({ ...contexto, callId: data.id, status: 'CREATED' })
      ultimoCanalId = data.id
      discadas++
      log(`LIGANDO ${rotulo} - tentativa ${regua.tentativaNumero}/10 - channel=${data.id}`)
    } catch (err) {
      const motivo = err.response?.data?.message || err.message
      try {
        await registrarTentativa({
          ...contexto,
          callId: `falha-${idempotencyKey}-${Date.now()}`,
          status: 'FAILED',
          failureClass: 'ORIGINATE_FAILED',
          hangupCause: motivo,
        })
      } catch { /* auditoria é best-effort */ }
      log(`FALHOU ${rotulo}: ${motivo}`)
      bloqueadas++
      continue
    }

    // Uma ligação por vez, DE VERDADE. ACHADO DA REVISÃO (17/09/2026): antes
    // esperávamos só PAUSA_MS (45s), mas uma ligação com 4 turnos dura
    // 90-140s. Ou seja, a sobreposição era a regra. E os workers Python são
    // UM processo com loop serial de stdin e timeout de 25s por requisição:
    // a segunda ligação estourava o timeout, o TTS falhava e o cliente — que
    // já tinha atendido — ouvia o áudio de fallback no meio da conversa.
    // Agora esperamos o canal SUMIR do Asterisk antes de discar o próximo.
    if (discadas < fila.length) {
      log(`   aguardando a ligação atual terminar antes da próxima...`)
      const limite = Date.now() + ESPERA_MAXIMA_CHAMADA_MS
      while (Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 5000))
        let aindaAtiva = true
        try {
          const { data: canais } = await cliente.get('/channels')
          aindaAtiva = Array.isArray(canais) && canais.some((ch) => ch.id === ultimoCanalId)
        } catch {
          // Sem conseguir consultar o ARI, tratamos como ainda ativa —
          // fail-closed: melhor esperar demais que ligar por cima.
          aindaAtiva = true
        }
        if (!aindaAtiva) break
      }
      log(`   respiro de ${Math.round(PAUSA_MS / 1000)}s entre ligações...`)
      await new Promise((r) => setTimeout(r, PAUSA_MS))
    }
  }

  log('')
  log(`FIM - ${discadas} ligação(ões) disparada(s), ${bloqueadas} bloqueada(s).`)
}

// Só dispara main() quando o arquivo é executado diretamente (node
// scripts/voice/rodar-fila-cobranca.mjs) — nunca ao ser importado por um
// teste (que precisa de resolverAllowlistParaAutorizacao sem tocar
// Supabase/ARI). pathToFileURL evita divergência de formato entre
// process.argv[1] (caminho de SO, barra invertida no Windows) e
// import.meta.url (sempre file:// com barra normal).
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) {
  main().catch((err) => {
    console.error(`[fila-cobranca] ERRO FATAL: ${err.message}`)
    process.exitCode = 1
  })
}
