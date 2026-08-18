// 2026-08-15 — guard central de DNC/opt-out (collection_do_not_contact) para
// o caminho REAL de cobrança. Achado real: a tabela só era lida pelo shadow
// (nextBestAction.js/estaEmOptOut, usada só por decidirProximaAcao/NBA) — o
// envio de verdade (cron, /disparar, /disparar-individual, motor legado E
// motor v2) nunca verificava opt-out. Com 0 linhas em produção hoje o risco
// era zero na prática, mas era um gap latente real.
//
// Schema de collection_do_not_contact (produção): id, cliente_telefone
// (chave — não é conta/cliente, é telefone), motivo, canal (default 'todos'),
// solicitado_em, registrado_por, expira_em (migration 20260101000042).
// expira_em NULL = opt-out permanente até remoção manual (comportamento
// original, preservado 100%). expira_em não-NULL = bloqueio TEMPORÁRIO, para
// de valer sozinho quando o instante passa — usado pelo bloqueio de telefone
// inválido (ver registrarBloqueioNumeroInvalidoHoje abaixo), que reusa esta
// MESMA tabela/guard em vez de inventar um mecanismo novo.
import { supabase } from '../supabase-admin.server.js'
import { registrarEvento, ORIGEM } from './timeline.js'
import { hojeBrtISO } from './collectionContactPolicy.js'

export const MOTIVO_NUMERO_INVALIDO_HOJE = 'numero_invalido_whatsapp'

// Leitura compartilhada — MESMA query usada pelo guard real (fail-closed,
// abaixo) e por nextBestAction.js/estaEmOptOut() (shadow, fail-open,
// comportamento preservado 100%) — single source of truth sobre "o que conta
// como opt-out", pra shadow e caminho real nunca divergirem sobre isso.
//
// `canais` (2026-08-16) — parametrizado pra reuso pelo guard de voz
// (collection_do_not_contact.canal já suporta 'ligacao', ver migration
// collection_v2_calls_operators — só nunca tinha sido consultado). Default
// preserva EXATAMENTE o comportamento anterior pra todo chamador existente
// (WhatsApp) — nenhum comportamento muda pra quem não passar o parâmetro.
//
// Leitura sem filtrar expira_em na query — o compat client local (Postgres
// direto, ver pgCompatClient.js) não implementa .or()/.is(), então o filtro
// "NULL ou ainda não expirou" é feito em memória por registroAindaValido()
// abaixo, nos dois chamadores (guard real e shadow). Tabela pequena por
// natureza (opt-out real é raro, bloqueio temporário expira sozinho em até
// 1 dia) — sem custo real em trazer as poucas linhas por telefone e filtrar
// em JS.
export async function buscarRegistroDoNotContact(clienteTelefone, canais = ['todos', 'whatsapp']) {
  if (!clienteTelefone) return { data: [], error: null }
  return supabase
    .from('collection_do_not_contact')
    .select('id, motivo, expira_em')
    .eq('cliente_telefone', clienteTelefone)
    .in('canal', canais)
}

// 2026-08-18 — expira_em NULL = permanente (sempre vale); não-NULL só vale
// até o instante marcado. Compartilhado pelo guard real e pelo shadow — os
// dois precisam concordar sobre "isto ainda bloqueia?".
export function registroAindaValido(registro) {
  return !registro.expira_em || new Date(registro.expira_em) > new Date()
}

// Guard fail-closed: diferente do shadow (informativo, nunca guarda envio
// real), aqui um erro de consulta ao banco BLOQUEIA o envio — nunca deixa
// passar por causa de uma falha técnica do próprio guard.
//
// `reason` diferencia OPT_OUT (permanente, pedido do cliente) de
// NUMERO_INVALIDO_HOJE (temporário, telefone rejeitado pelo WhatsApp hoje) —
// mesma checagem, mesmo ponto de bloqueio, mas o motivo reportado no resumo/
// timeline continua preciso pra quem for auditar depois.
export async function estaEmDoNotContact(clienteTelefone, canais = ['todos', 'whatsapp']) {
  if (!clienteTelefone) return { blocked: false, reason: null }

  const { data, error } = await buscarRegistroDoNotContact(clienteTelefone, canais)
  if (error) {
    return { blocked: true, reason: 'DNC_GUARD_ERROR', erro: error.message }
  }
  const ativo = (data ?? []).find(registroAindaValido)
  if (ativo) {
    const reason = ativo.motivo === MOTIVO_NUMERO_INVALIDO_HOJE ? 'NUMERO_INVALIDO_HOJE' : 'OPT_OUT'
    return { blocked: true, reason }
  }
  return { blocked: false, reason: null }
}

// Meia-noite BRT do dia seguinte = 03:00 UTC do dia seguinte (BRT fixo
// UTC-3, Brasil não observa DST desde 2019) — mesmo padrão de
// inicioDoDiaBrtISO() em cobranca-whatsapp.js/globalSendLimit.js, só que
// marcando o FIM do dia corrente em vez do início.
function fimDoDiaBrtISO() {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  const [ano, mes, dia] = hojeBrt.split('-').map(Number)
  return new Date(Date.UTC(ano, mes - 1, dia + 1, 3, 0, 0, 0)).toISOString()
}

// CORREÇÃO DE SEGURANÇA 2026-08-18 — telefone com falha DEFINITIVA
// (PERMANENT_RECIPIENT/"número não registrado no WhatsApp") não pode
// continuar sendo tentado pelo provider pra cada título restante do mesmo
// cliente no mesmo dia (cada tentativa é uma chamada HTTP real de checagem
// contra a Evolution/WhatsApp, e o gap de rate-limit documentado em
// globalSendLimit.js/whatsappInstances.js não conta tentativas falhas —
// nada hoje protegia contra rajada de falhas repetidas pro mesmo número).
//
// Reusa collection_do_not_contact (canal='whatsapp', expira_em=fim do dia
// BRT) em vez de criar tabela/campo novo — o guard real
// (estaEmDoNotContact, já chamado ANTES de qualquer seleção de instância ou
// tentativa em collectionRouting.js) passa a bloquear automaticamente,
// sem call site novo. Nunca chamado para falha técnica/timeout/429/401/403
// — só o chamador (dispatchEngine.js, na categoria PERMANENT_RECIPIENT)
// decide quando isto se aplica; esta função em si não classifica nada.
//
// Idempotente por telefone+dia: um segundo título com o mesmo telefone
// falhando no mesmo dia não cria uma segunda linha (nem re-escreve
// expira_em, que já cobre o resto do dia). Best-effort — uma falha ao
// gravar este bloqueio nunca pode derrubar o fluxo de envio que já
// terminou (mesmo racional de registrarBloqueioOptOutSeNecessario abaixo).
export async function registrarBloqueioNumeroInvalidoHoje(clienteTelefone) {
  if (!clienteTelefone) return
  const agoraISO = new Date().toISOString()
  try {
    const { data: jaBloqueadoHoje, error: erroConsulta } = await supabase
      .from('collection_do_not_contact')
      .select('id')
      .eq('cliente_telefone', clienteTelefone)
      .eq('canal', 'whatsapp')
      .eq('motivo', MOTIVO_NUMERO_INVALIDO_HOJE)
      .gt('expira_em', agoraISO)
      .limit(1)
    if (erroConsulta) return
    if ((jaBloqueadoHoje?.length ?? 0) > 0) return

    await supabase.from('collection_do_not_contact').insert({
      cliente_telefone: clienteTelefone,
      canal: 'whatsapp',
      motivo: MOTIVO_NUMERO_INVALIDO_HOJE,
      expira_em: fimDoDiaBrtISO(),
    })
  } catch (erro) {
    console.error('[doNotContactGuard] falha ao registrar bloqueio de número inválido (best-effort, não afeta o envio já concluído):', erro.message)
  }
}

// Timeline de auditoria do bloqueio — no máximo 1 evento por (título, dia),
// nunca 1 por ciclo/tentativa (um título em DNC pode ser reavaliado várias
// vezes no mesmo dia pelo cron dentro da janela 08h-17h, já que nunca chega a
// 'sent' e portanto nunca é marcado como "já enviado hoje" — sem esta
// deduplicação, cada ciclo geraria um novo evento de timeline pro mesmo
// título, o mesmo dia).
export async function registrarBloqueioOptOutSeNecessario({ contasFinanceirasId, clienteTelefone, reason }) {
  const inicioHojeBrt = `${hojeBrtISO()}T00:00:00-03:00`
  const { data: jaRegistrado, error: erroConsulta } = await supabase
    .from('collection_timeline_events')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .eq('tipo', 'COBRANCA_BLOQUEADA_OPT_OUT')
    .gte('criado_em', inicioHojeBrt)
    .limit(1)
  if (erroConsulta || (jaRegistrado?.length ?? 0) > 0) return // já registrado hoje, ou consulta falhou — nunca falha o bloqueio em si por causa da auditoria

  // Auditoria é best-effort: uma falha ao escrever a timeline nunca pode
  // derrubar o guard em si (o bloqueio do envio já aconteceu antes de chamar
  // esta função — ver enviarCobrancaComRoteamento).
  try {
    await registrarEvento({
      contasFinanceirasId, clienteTelefone, tipo: 'COBRANCA_BLOQUEADA_OPT_OUT', origem: ORIGEM.SYSTEM,
      canal: 'whatsapp', descricao: `Envio de cobrança bloqueado — cliente em opt-out/DNC (${reason})`,
      dados: { reason },
    })
  } catch {
    // silencioso de propósito — ver comentário acima
  }
}
