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

// CORREÇÃO 2026-08-27 — achado real da auditoria de qualidade de telefones:
// 183 permanent_recipient em 30 dias, mas só 39 telefones únicos — 36
// reincidiram, um chegou a 28 tentativas no mesmo mês. O bloqueio de "até
// meia-noite BRT" (fimDoDiaBrtISO, usado até aqui) deixava o MESMO telefone
// já confirmado pelo provider como não registrado voltar a ser tentado todo
// dia seguinte — 100% dessas tentativas dependiam do provider pra falhar de
// novo (nenhuma validação estrutural local teria evitado nenhuma delas, ver
// auditoria), então o único jeito de reduzir volume é parar de reconsultar
// um número que JÁ foi confirmado. Troca a janela de "hoje" para 30 dias —
// nunca permanente automático (pedido explícito: reincidência não vira
// bloqueio definitivo sozinha; expira e permite nova tentativa real depois).
const QUARENTENA_NUMERO_INVALIDO_DIAS = 30

export function expiracaoQuarentenaDeHoje() {
  return new Date(Date.now() + QUARENTENA_NUMERO_INVALIDO_DIAS * 24 * 60 * 60 * 1000).toISOString()
}

// Idempotente/nunca encurta: uma linha temporária já mais longa que a nova
// quarentena (ex: ajuste manual futuro, ou corrida entre 2 títulos do mesmo
// telefone no mesmo instante) nunca é reduzida — só estendida ou mantida.
// NUNCA chamada para a linha permanente (expira_em NULL) — quem chama já
// retorna antes disso (ver registrarBloqueioNumeroInvalidoHoje).
export function proximaExpiracaoQuarentena(expiraAtualIso) {
  const candidata = expiracaoQuarentenaDeHoje()
  if (!expiraAtualIso) return candidata
  return new Date(expiraAtualIso) > new Date(candidata) ? expiraAtualIso : candidata
}

// CORREÇÃO DE SEGURANÇA 2026-08-18 — telefone com falha DEFINITIVA
// (PERMANENT_RECIPIENT/"número não registrado no WhatsApp") não pode
// continuar sendo tentado pelo provider pra cada título restante do mesmo
// cliente (cada tentativa é uma chamada HTTP real de checagem contra a
// Evolution/WhatsApp, e o gap de rate-limit documentado em
// globalSendLimit.js/whatsappInstances.js não conta tentativas falhas —
// nada hoje protegia contra rajada de falhas repetidas pro mesmo número).
//
// AMPLIAÇÃO 2026-08-27 — janela de bloqueio de "até meia-noite BRT" (nome
// da função/motivo preservado por compatibilidade — MOTIVO_NUMERO_INVALIDO_HOJE
// e o `reason` 'NUMERO_INVALIDO_HOJE' continuam com esse valor exato, é
// contrato já checado por outros callers/testes) para QUARENTENA_NUMERO_INVALIDO_DIAS
// (30 dias). Ver expiracaoQuarentenaDeHoje()/proximaExpiracaoQuarentena()
// acima pro racional completo.
//
// Reusa collection_do_not_contact (canal='whatsapp', expira_em=quarentena de
// 30 dias) em vez de criar tabela/campo novo — o guard real
// (estaEmDoNotContact, já chamado ANTES de qualquer seleção de instância ou
// tentativa em collectionRouting.js) passa a bloquear automaticamente,
// sem call site novo. Nunca chamado para falha técnica/timeout/429/401/403
// — só o chamador (dispatchEngine.js, na categoria PERMANENT_RECIPIENT)
// decide quando isto se aplica; esta função em si não classifica nada.
//
// Idempotente por telefone+quarentena ativa: um segundo título com o mesmo
// telefone, ainda dentro da janela de 30 dias, não cria uma segunda linha
// nem reinicia a contagem (só reinicia quando a quarentena anterior já
// expirou e uma NOVA falha real do provider confirma de novo — nunca vira
// permanente só por reincidência, pedido explícito). Best-effort — uma
// falha ao gravar este bloqueio nunca pode derrubar o fluxo de envio que já
// terminou (mesmo racional de registrarBloqueioOptOutSeNecessario abaixo).
//
// SEGURANÇA 2026-08-18 (revisão pós-PR) — collection_do_not_contact tem uma
// UNIQUE INDEX real de produção em (cliente_telefone, canal), SEM motivo
// (idx_collection_dnc_telefone_canal, migrations/collection_shadow_minimal.sql
// — já aplicada, fora do pipeline supabase/migrations/): só pode existir 1
// linha por telefone+canal, qualquer que seja o motivo. Por isso:
// - NUNCA faz INSERT às cegas: sempre consulta a linha existente pra
//   (telefone, 'whatsapp') primeiro (no máx 1, garantido pela constraint).
// - expira_em NULL = permanente, DE QUALQUER MOTIVO (opt-out real ou
//   qualquer outra origem futura) — nunca é tocado, nunca vira UPDATE nem é
//   sobrescrito por um INSERT concorrente. Retorna imediatamente.
// - Só a PRÓPRIA linha (motivo === MOTIVO_NUMERO_INVALIDO_HOJE) pode ser
//   atualizada, e só pra ESTENDER expira_em (nunca pra criar, nunca pra
//   mudar motivo) — cobre o caso de um bloqueio de um dia anterior já
//   expirado ocupando o slot único.
// - INSERT só acontece quando NÃO existe nenhuma linha pra este
//   telefone+canal — nesse caso é estruturalmente impossível conflitar com
//   um opt-out permanente (ele ocuparia o slot e teria sido encontrado
//   acima). 23505 remanescente (corrida entre 2 títulos do mesmo telefone
//   falhando quase ao mesmo tempo) é esperado e não é erro real.
export async function registrarBloqueioNumeroInvalidoHoje(clienteTelefone) {
  if (!clienteTelefone) return
  try {
    const { data: existente, error: erroConsulta } = await supabase
      .from('collection_do_not_contact')
      .select('id, motivo, expira_em')
      .eq('cliente_telefone', clienteTelefone)
      .eq('canal', 'whatsapp')
      .maybeSingle()
    if (erroConsulta) {
      console.error('[doNotContactGuard] falha ao consultar bloqueio existente (best-effort, não afeta o envio já concluído):', erroConsulta.message)
      return
    }

    if (existente) {
      if (!existente.expira_em) return // permanente (qualquer motivo) — nunca toca
      if (existente.motivo === MOTIVO_NUMERO_INVALIDO_HOJE && new Date(existente.expira_em) > new Date()) return // quarentena ainda ativa — idempotente, nunca reinicia a contagem
      // Só resta: linha própria (numero_invalido_whatsapp) com quarentena já
      // expirada — nova falha real do provider renova por mais 30 dias
      // (nunca menos que o que já tinha, ver proximaExpiracaoQuarentena),
      // nunca muda motivo/telefone/canal.
      const { error: erroUpdate } = await supabase
        .from('collection_do_not_contact')
        .update({ expira_em: proximaExpiracaoQuarentena(existente.expira_em) })
        .eq('id', existente.id)
      if (erroUpdate) console.error('[doNotContactGuard] falha ao renovar bloqueio de número inválido (best-effort):', erroUpdate.message)
      return
    }

    const { error: erroInsert } = await supabase.from('collection_do_not_contact').insert({
      cliente_telefone: clienteTelefone,
      canal: 'whatsapp',
      motivo: MOTIVO_NUMERO_INVALIDO_HOJE,
      expira_em: expiracaoQuarentenaDeHoje(),
    })
    if (erroInsert && erroInsert.code !== '23505') {
      console.error('[doNotContactGuard] falha ao registrar bloqueio de número inválido (best-effort, não afeta o envio já concluído):', erroInsert.message)
    }
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
