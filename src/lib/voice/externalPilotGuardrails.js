// Voice AI EXTERNAL PILOT READINESS — guardrails PUROS (sem rede/ARI/DB
// aqui) que qualquer futura chamada externa precisará passar TODOS antes de
// originar. Cada função recebe o estado necessário como parâmetro — nunca
// consulta nada sozinha — pra ser 100% testável sem infraestrutura real.
//
// Regra de composição: `avaliarAutorizacaoChamadaExterna` roda TODOS os
// checks e só autoriza se TODOS passarem. Sem flag + allowlist, nunca
// origina — mesmo que todo o resto esteja correto.
import { TIPO_DESTINO, resolverDestino } from './destinoResolver.js'

export function avaliarFlagExternalHabilitada(flags) {
  return flags?.voice_external_enabled === true
}

export function avaliarNumeroNaAllowlist(numero, allowlist) {
  return Array.isArray(allowlist) && allowlist.includes(numero)
}

// idempotencyKey nova (ainda não processada) -> pode prosseguir.
export function avaliarIdempotencia(idempotencyKey, chavesJaProcessadas) {
  if (!idempotencyKey) return false
  const chaves = chavesJaProcessadas instanceof Set ? chavesJaProcessadas : new Set(chavesJaProcessadas || [])
  return !chaves.has(idempotencyKey)
}

export function avaliarChamadaDuplicadaAtiva(numero, chamadasAtivas) {
  const lista = Array.isArray(chamadasAtivas) ? chamadasAtivas : []
  return !lista.some((c) => c.numero === numero && c.status !== 'HANGUP' && c.status !== 'COMPLETED' && c.status !== 'NO_ANSWER' && c.status !== 'BUSY' && c.status !== 'FAILED')
}

// Fail-closed por padrão: sem política explícita com pelo menos uma janela,
// NUNCA autoriza — não herda horário comercial "padrão" às cegas.
export function avaliarHorarioPermitido(horaAtual, politica) {
  if (!politica || !Array.isArray(politica.janelas) || politica.janelas.length === 0) return false
  const diaSemana = horaAtual.getDay()
  const minutoDoDia = horaAtual.getHours() * 60 + horaAtual.getMinutes()
  return politica.janelas.some((janela) => {
    if (Array.isArray(janela.dias) && !janela.dias.includes(diaSemana)) return false
    return minutoDoDia >= janela.inicioMinutos && minutoDoDia < janela.fimMinutos
  })
}

export function avaliarLimiteDiarioPorTelefone(numero, chamadasHoje, limiteDiario) {
  if (!(limiteDiario > 0)) return false
  const contagem = (Array.isArray(chamadasHoje) ? chamadasHoje : []).filter((c) => c.numero === numero).length
  return contagem < limiteDiario
}

// Ponto de entrada único — combina TODOS os guards. Retorna
// {permitido, motivo} — motivo sempre preenchido quando permitido=false,
// pra auditoria (item 11: "motivo/origem da chamada").
export function avaliarAutorizacaoChamadaExterna({
  flags, numero, allowlist, idempotencyKey, chavesJaProcessadas,
  chamadasAtivas, horaAtual, politicaHorario, chamadasHoje, limiteDiario,
} = {}) {
  try {
    resolverDestino(TIPO_DESTINO.EXTERNAL)
  } catch (err) {
    return { permitido: false, motivo: `sem_trunk: ${err.message}` }
  }
  if (!avaliarFlagExternalHabilitada(flags)) return { permitido: false, motivo: 'flag_desabilitada: voice_external_enabled não está true' }
  if (!avaliarNumeroNaAllowlist(numero, allowlist)) return { permitido: false, motivo: `fora_da_allowlist: "${numero}" não está na allowlist de teste` }
  if (!avaliarIdempotencia(idempotencyKey, chavesJaProcessadas)) return { permitido: false, motivo: `idempotencia: chave "${idempotencyKey}" já foi processada` }
  if (!avaliarChamadaDuplicadaAtiva(numero, chamadasAtivas)) return { permitido: false, motivo: `chamada_ja_ativa: já existe uma chamada em andamento para "${numero}"` }
  if (!avaliarHorarioPermitido(horaAtual, politicaHorario)) return { permitido: false, motivo: 'fora_do_horario: nenhuma janela permitida cobre o horário atual (fail-closed sem política configurada)' }
  if (!avaliarLimiteDiarioPorTelefone(numero, chamadasHoje, limiteDiario)) return { permitido: false, motivo: `limite_diario_excedido: "${numero}" já atingiu o limite de chamadas hoje` }
  return { permitido: true, motivo: null }
}
