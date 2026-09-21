// Resolução de identidade @lid -> telefone real, para o fluxo COMERCIAL do
// WhatsApp (sdr.js/webhook-handler.js) — nunca usado pelo motor financeiro.
//
// Contexto (continuação do incidente "WhatsApp/IA sem resposta", PR #111,
// 2026-09-21): quando o WhatsApp aplica a política de privacidade "Linked
// ID", a Evolution API entrega key.remoteJid como "<lid>@lid" sem revelar o
// telefone real — às vezes key.remoteJidAlt traz o telefone junto (mesma
// mensagem), às vezes não vem nada. Pesquisa confirmou que isto é um
// problema conhecido, sem solução garantida, no próprio Baileys (a lib por
// trás da Evolution API): nenhum endpoint read-only (findContacts/
// findChats) guarda um telefone associado a um @lid não visto antes — o
// schema Prisma público da Evolution API (model Contact) só tem
// remoteJid/pushName/profilePicUrl, nenhum campo de telefone alternativo. A
// resposta oficial de um mantenedor do Baileys (WhiskeySockets/Baileys
// discussion #2551, 2026-05-19) é explícita: "getPNForLID only succeeds for
// pairs Baileys has previously cached from inbound traffic — it cannot
// fetch a PN for an unknown LID (...) you keep your own persistent LID<->PN
// cache over time" — não existe atalho: é o app quem precisa lembrar.
//
// Por isso esta resolução NUNCA inventa telefone a partir dos dígitos do
// @lid (isso seria o mesmo bug de "leads fantasma" do commit 4fa14d8,
// 2026-07-06) — só usa (a) remoteJidAlt da própria mensagem, quando
// presente, ou (b) um mapeamento já confirmado anteriormente por (a) e
// persistido em whatsapp_lid_telefone (migration 20260101000074). Sem
// nenhuma das duas provas, falha fechado: retorna telefone=null.
import { supabase } from './supabase-admin.server.js'
import { mascararTelefone } from './telefone.js'

// Mesma env var e mesmo racional de src/routes/sdr.js (SDR_QUERY_TIMEOUT_MS,
// achado do incidente "IA comercial não responde", 2026-09-13): nenhuma
// leitura/escrita deste módulo pode travar o processamento de uma mensagem
// por tempo indefinido. Configurável só para teste.
const LID_QUERY_TIMEOUT_MS = Number(process.env.SDR_QUERY_TIMEOUT_MS) || 8000

function digitosTelefone(jid) {
  return (jid ?? '').replace('@s.whatsapp.net', '').replace('@lid', '')
}

// Consulta o cache (fail-closed: qualquer erro ou timeout vira "não
// mapeado", nunca lança e nunca inventa telefone).
async function buscarMapeamento({ lid, instanceName, correlationId }) {
  try {
    const { data, error } = await supabase
      .from('whatsapp_lid_telefone')
      .select('telefone')
      .eq('lid', lid)
      .eq('instance_name', instanceName)
      .maybeSingle()
      .abortSignal(AbortSignal.timeout(LID_QUERY_TIMEOUT_MS))
    if (error) {
      console.error(`[whatsapp-lid] falha ao consultar cache de mapeamento (codigo=${error.code ?? 'desconhecido'}) correlationId=${correlationId ?? ''}`)
      return { telefone: null, motivo: 'falha_consulta_cache', lidMascarado: mascararTelefone(lid) }
    }
    if (!data) return { telefone: null, motivo: 'lid_sem_remoteJidAlt_e_sem_cache', lidMascarado: mascararTelefone(lid) }
    return { telefone: data.telefone, origem: 'cache' }
  } catch (err) {
    // AbortSignal.timeout estourado cai aqui na prática (a promise do
    // encadeamento supabase-js rejeita) — mesmo tratamento de qualquer
    // outra falha: fail-closed, nunca usa os dígitos do lid como telefone.
    console.error(`[whatsapp-lid] excecao/timeout ao consultar cache (codigo=${err?.code ?? 'desconhecido'}) correlationId=${correlationId ?? ''}`)
    return { telefone: null, motivo: 'timeout_consulta_cache', lidMascarado: mascararTelefone(lid) }
  }
}

// Grava (best-effort, nunca bloqueia o turno) um mapeamento confirmado pela
// própria Evolution nesta mensagem. Política de conflito: nunca sobrescreve
// um mapeamento já existente com um telefone DIFERENTE — um mesmo lid mudar
// de telefone é anômalo (não é o comportamento esperado do WhatsApp) e
// sobrescrever silenciosamente arriscaria redirecionar o histórico de
// conversa de uma lead para o telefone de outra pessoa. Mantém o primeiro
// valor confirmado; só loga para revisão manual (mesmo padrão já usado para
// ctwa_clid em webhook-handler.js: "nunca sobrescreve um valor já
// registrado").
async function registrarMapeamento({ lid, telefone, instanceName, correlationId }) {
  try {
    const { data: existente, error: erroLeitura } = await supabase
      .from('whatsapp_lid_telefone')
      .select('telefone')
      .eq('lid', lid)
      .eq('instance_name', instanceName)
      .maybeSingle()
      .abortSignal(AbortSignal.timeout(LID_QUERY_TIMEOUT_MS))
    if (erroLeitura) {
      console.error(`[whatsapp-lid] falha ao verificar mapeamento existente antes de gravar (codigo=${erroLeitura.code ?? 'desconhecido'}) correlationId=${correlationId ?? ''}`)
      return
    }

    if (existente) {
      if (existente.telefone !== telefone) {
        console.warn(`[whatsapp-lid:conflito] lid já mapeado para outro telefone — mantendo o valor original, sem sobrescrever. correlationId=${correlationId ?? ''}`)
      }
      return
    }

    const { error: erroInsert } = await supabase
      .from('whatsapp_lid_telefone')
      .insert({ lid, instance_name: instanceName, telefone })
      .abortSignal(AbortSignal.timeout(LID_QUERY_TIMEOUT_MS))
    // 23505 = unique_violation — duas mensagens quase simultâneas do mesmo lid
    // (processarLara e processWhatsappEvent rodam para o mesmo evento) podem
    // correr pra gravar o mesmo mapeamento ao mesmo tempo; quem perder a
    // corrida esbarra na PK (lid, instance_name) já preenchida pelo outro —
    // não é erro, é o resultado esperado de idempotência.
    if (erroInsert && erroInsert.code !== '23505') {
      console.error(`[whatsapp-lid] falha ao gravar mapeamento novo (codigo=${erroInsert.code ?? 'desconhecido'}) correlationId=${correlationId ?? ''}`)
    }
  } catch (err) {
    console.error(`[whatsapp-lid] excecao ao gravar mapeamento (codigo=${err?.code ?? 'desconhecido'}) correlationId=${correlationId ?? ''}`)
  }
}

// Único ponto de decisão usado tanto por processarLara (sdr.js) quanto por
// processWhatsappEvent (webhook-handler.js) — garante que os dois caminhos
// nunca voltem a divergir nesta regra (foi exatamente essa divergência que
// deixou webhook-handler.js sem a proteção que sdr.js ganhou na PR #111).
//
// Retorno: { telefone, origem } quando resolvido ('direto' | 'remoteJidAlt'
// | 'cache'); { telefone: null, motivo, lidMascarado? } quando não há prova
// suficiente — motivo é sempre um destes: 'telefone_vazio' | 'lid_vazio' |
// 'lid_sem_remoteJidAlt_e_sem_cache' | 'falha_consulta_cache' |
// 'timeout_consulta_cache'. lidMascarado (só os últimos 4 dígitos, nunca o
// lid completo) vem preenchido sempre que o motivo envolve um @lid — só pra
// permitir correlacionar descartes repetidos do MESMO contato em log, sem
// nunca expor o identificador completo.
export async function resolverTelefoneReal({ remoteJid, remoteJidAlt, instanceName, correlationId }) {
  const jid = remoteJid ?? ''
  if (!jid.endsWith('@lid')) {
    const telefone = digitosTelefone(jid)
    return telefone ? { telefone, origem: 'direto' } : { telefone: null, motivo: 'telefone_vazio' }
  }

  const lid = jid.replace('@lid', '')
  if (!lid) return { telefone: null, motivo: 'lid_vazio' }

  // O próprio WhatsApp revelou o telefone real nesta mensagem — prova de
  // primeira mão, sempre a fonte mais confiável que existe. Persiste (best
  // effort, não bloqueia a resposta desta mensagem) para reaproveitar em
  // mensagens futuras do mesmo lid sem remoteJidAlt.
  const alt = digitosTelefone(remoteJidAlt ?? '')
  if (alt) {
    registrarMapeamento({ lid, telefone: alt, instanceName, correlationId }).catch(() => {})
    return { telefone: alt, origem: 'remoteJidAlt' }
  }

  // Sem prova nesta mensagem — a única fonte legítima que resta é um
  // mapeamento já confirmado anteriormente (ver registrarMapeamento acima).
  // Nunca inventa a partir dos dígitos do lid.
  return buscarMapeamento({ lid, instanceName, correlationId })
}
