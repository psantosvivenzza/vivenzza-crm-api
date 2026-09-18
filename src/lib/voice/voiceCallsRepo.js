// Acesso a voice_calls — a ÚNICA porta entre a régua/guardrails (lógica pura)
// e o banco. Quem decide se pode ligar continua sendo função pura; este
// módulo só busca o estado e grava o que aconteceu.
//
// CORREÇÃO ESTRUTURAL (17/09/2026): até hoje o histórico era um stub que
// devolvia arrays vazios, porque a migration de voice_calls nunca tinha sido
// aplicada. Consequência real: o sistema SEMPRE enxergava "nenhuma ligação
// feita hoje" e liberava tudo — os tetos por hora, por dia e por telefone
// existiam só no papel. Com a tabela aplicada, isto aqui passa a ser a trava
// de verdade.
import { supabase } from '../supabase-admin.server.js'
import { hashTelefone } from './reguaTentativas.js'
import { TIMEZONE_COBRANCA } from './externalPilotGuardrails.js'

const TABELA = 'voice_calls'

// Status que significam "a chamada foi efetivamente atendida por alguém".
const STATUS_ATENDIDA = new Set(['ANSWERED', 'COMPLETED', 'BRIDGED'])
// Status que significam "ainda está no ar".
const STATUS_ATIVA = new Set(['CREATED', 'RINGING', 'ANSWERED', 'BRIDGED'])

function inicioDoDiaBrtISO(agora = new Date()) {
  const diaBrt = agora.toLocaleDateString('en-CA', { timeZone: TIMEZONE_COBRANCA })
  // BRT = UTC-3 fixo (o Brasil não tem horário de verão desde 2019).
  return `${diaBrt}T03:00:00.000Z`
}

function linhaParaTentativa(linha) {
  return {
    criadoEm: linha.criado_em,
    // Contato humano efetivo conta como atendida para a régua (trava de 7
    // dias), mesmo que a ligação do robô tenha caído na caixa postal. Sem
    // isto, o robô ligaria de novo para quem a Nicole acabou de atender.
    atendida: STATUS_ATENDIDA.has(linha.status) || linha.contato_humano_efetivo === true,
    dataPrometida: linha.data_prometida ?? null,
    cicloIniciadoEm: linha.ciclo_iniciado_em ?? null,
    faixaHorario: linha.faixa_horario ?? null,
    tentativaNumero: linha.tentativa_numero ?? null,
    status: linha.status,
  }
}

/**
 * Estado necessário para TODOS os guards, numa ida só ao banco por escopo.
 * Substitui o antigo stub buscarHistoricoChamadasExternas().
 */
export async function buscarEstadoChamadasExternas({ numero, agora = new Date() } = {}) {
  const telefoneHash = hashTelefone(numero)
  const inicioDia = inicioDoDiaBrtISO(agora)
  const umaHoraAtras = new Date(agora.getTime() - 60 * 60 * 1000).toISOString()
  const trintaDiasAtras = new Date(agora.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString()

  const [globalHoje, doTelefone, ativas] = await Promise.all([
    supabase
      .from(TABELA)
      .select('criado_em, idempotency_key, status, telefone_hash')
      .eq('destination_type', 'EXTERNAL')
      .gte('criado_em', inicioDia),
    telefoneHash
      ? supabase
          .from(TABELA)
          .select('criado_em, status, data_prometida, ciclo_iniciado_em, faixa_horario, tentativa_numero, contato_humano_efetivo')
          .eq('telefone_hash', telefoneHash)
          .gte('criado_em', trintaDiasAtras)
          .order('criado_em', { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from(TABELA)
      .select('criado_em, status, telefone_hash')
      .eq('destination_type', 'EXTERNAL')
      // ACHADO DA REVISÃO (17/09/2026): esta query não tinha recorte de
      // tempo. Uma linha que ficasse presa em CREATED (serviço de voz fora
      // do ar no instante da originação, evento perdido) bloqueava aquele
      // telefone em "chamada_já_ativa" PARA SEMPRE, sem TTL — o cliente saía
      // da fila em silêncio e ninguém ficava sabendo. Falha fechada, então
      // não é perigosa, mas é armadilha operacional. Uma ligação nunca dura
      // mais que minutos: o que passou de 1 hora é registro órfão.
      .gte('criado_em', new Date(Date.now() - 60 * 60 * 1000).toISOString())
      .in('status', [...STATUS_ATIVA]),
  ])

  for (const resultado of [globalHoje, doTelefone, ativas]) {
    // Fail-closed: erro de leitura NUNCA pode virar "histórico vazio" —
    // esse foi exatamente o modo de falha que deixou os limites inertes.
    if (resultado.error) throw new Error(`voice_calls: falha ao ler histórico — ${resultado.error.message}`)
  }

  const linhasHoje = globalHoje.data ?? []
  const linhasTelefone = doTelefone.data ?? []

  // BUG REAL corrigido em 17/09/2026, no primeiro lote de fila: antes, TODA
  // ligação do dia era etiquetada com o número que estava sendo avaliado.
  // avaliarLimiteDiarioPorTelefone() conta as entradas cujo `numero` bate, então
  // bastava UMA ligação qualquer ter saído no dia para o limite por telefone
  // (1/dia) bloquear TODO o resto da fila. O número só pode ser preenchido
  // quando o hash realmente corresponde a este telefone.
  const ehEsteTelefone = (l) => Boolean(telefoneHash) && l.telefone_hash === telefoneHash

  return {
    chamadasHoje: linhasHoje.map((l) => ({ numero: ehEsteTelefone(l) ? numero : null, criadoEm: l.criado_em })),
    chamadasUltimaHora: linhasHoje.filter((l) => l.criado_em >= umaHoraAtras).map((l) => ({ numero: ehEsteTelefone(l) ? numero : null, criadoEm: l.criado_em })),
    chamadasAtivas: (ativas.data ?? []).map((l) => ({
      numero: l.telefone_hash === telefoneHash ? numero : null,
      status: l.status,
    })),
    chavesJaProcessadas: linhasHoje.map((l) => l.idempotency_key).filter(Boolean),
    historicoTelefone: linhasTelefone.map(linhaParaTentativa),
    telefoneHash,
  }
}

/**
 * Registra a tentativa. Chamado SEMPRE — inclusive quando a chamada nem sai.
 * Painel que só grava sucesso esconde exatamente o dado que indica bloqueio
 * de operadora (volume alto com taxa de atendimento baixa).
 */
export async function registrarTentativa({
  callId,
  numero,
  status = 'CREATED',
  destinationType = 'EXTERNAL',
  destinationMasked,
  idempotencyKey = null,
  contaId = null,
  codigoCliente = null,
  clienteNome = null,
  numeroOrigem = null,
  campanha = null,
  tentativaNumero = null,
  cicloIniciadoEm = null,
  faixaHorario = null,
  failureClass = null,
  hangupCause = null,
} = {}) {
  const { data, error } = await supabase
    .from(TABELA)
    .insert({
      call_id: callId,
      direction: 'outbound',
      destination_type: destinationType,
      destination_masked: destinationMasked,
      telefone_hash: hashTelefone(numero),
      status,
      idempotency_key: idempotencyKey,
      conta_id: contaId,
      codigo_cliente: codigoCliente,
      cliente_nome: clienteNome,
      numero_origem: numeroOrigem,
      campanha,
      tentativa_numero: tentativaNumero,
      ciclo_iniciado_em: cicloIniciadoEm,
      faixa_horario: faixaHorario,
      failure_class: failureClass,
      hangup_cause: hangupCause,
    })
    .select('id, call_id')
    .single()

  if (error) throw new Error(`voice_calls: falha ao registrar tentativa — ${error.message}`)
  return data
}

/** Fecha o registro quando a chamada termina (ou falha). */
export async function finalizarTentativa({
  callId,
  status,
  answeredAt = null,
  endedAt = new Date().toISOString(),
  durationSeconds = null,
  hangupCause = null,
  failureClass = null,
  intentFinal = null,
  requiresHuman = null,
  transcricao = null,
  gravacaoPath = null,
  valorPrometido = null,
  dataPrometida = null,
} = {}) {
  const patch = { status, ended_at: endedAt }
  if (answeredAt !== null) patch.answered_at = answeredAt
  if (durationSeconds !== null) patch.duration_seconds = durationSeconds
  if (hangupCause !== null) patch.hangup_cause = hangupCause
  if (failureClass !== null) patch.failure_class = failureClass
  if (intentFinal !== null) patch.intent_final = intentFinal
  if (requiresHuman !== null) patch.requires_human = requiresHuman
  if (transcricao !== null) patch.transcricao = transcricao
  if (gravacaoPath !== null) patch.gravacao_path = gravacaoPath
  if (valorPrometido !== null) patch.valor_prometido = valorPrometido
  if (dataPrometida !== null) patch.data_prometida = dataPrometida

  const { error } = await supabase.from(TABELA).update(patch).eq('call_id', callId)
  if (error) throw new Error(`voice_calls: falha ao finalizar tentativa — ${error.message}`)
}
