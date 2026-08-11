// Motor de decisão do hard-cap de spend do Meta Ads — funções PURAS (sem rede,
// sem banco), pra dar pra testar exaustivamente sem depender de API real. A
// orquestração (I/O de verdade) fica em src/jobs/meta-budget-guard.js.

export const LIMIAR_ALERTA_PADRAO = 115
export const LIMIAR_PROTECAO_PADRAO = 125

// Fail-safe: qualquer spend que não seja um número válido (leitura falhou, API
// não configurada, etc.) sempre decide NENHUMA — nunca assume/inventa spend.
export function decidirNivel({ spend, alertaThreshold = LIMIAR_ALERTA_PADRAO, protecaoThreshold = LIMIAR_PROTECAO_PADRAO }) {
  if (typeof spend !== 'number' || Number.isNaN(spend)) return 'NENHUMA'
  if (spend >= protecaoThreshold) return 'PROTECAO'
  if (spend >= alertaThreshold) return 'ALERTA'
  return 'NENHUMA'
}

// Data (YYYY-MM-DD) no timezone real da conta Meta — não UTC, não o timezone do
// servidor. `date` é injetado pelo chamador (em vez de usar `new Date()` aqui
// dentro) só pra manter a função pura/testável com qualquer instante fixo.
export function diaContaBrt(date, timezone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date)
}

// Quais pausas feitas pelo próprio guard em dias anteriores ainda não foram
// desfeitas — usado no início de cada tick pra reativar antes de avaliar o dia
// corrente. Nunca inclui nada que o guard não pausou (logsAnteriores só tem
// entidades que passaram pelo próprio fluxo de proteção). Uma pausa é resolvida
// por 'resumed' (reativação de verdade) OU 'manual_override' (alguém mexeu na
// campanha depois da pausa — o guard não sobrescreve, só registra e para de
// tentar de novo todo tick).
export function pausasPendentesDeReativacao({ logsAnteriores, diaContaAtual }) {
  const pausadas = logsAnteriores.filter((l) => l.action === 'paused' && l.dia_conta < diaContaAtual)
  const idsJaResolvidos = new Set(
    logsAnteriores
      .filter((l) => l.action === 'resumed' || l.action === 'manual_override')
      .map((l) => l.pause_action_id)
  )
  return pausadas.filter((p) => !idsJaResolvidos.has(p.id))
}

// Decide o que fazer com uma pausa pendente, dado o status ATUAL da entidade na
// Meta (lido antes de agir, sempre). Pura — a leitura/gravação de verdade fica
// no job.
//   'PAUSED'  -> guard deixou como deixou, segue o fluxo normal: reativar.
//   qualquer outra coisa (ACTIVE, DELETED, ARCHIVED, ...) -> alguém/algo mudou
//   depois da pausa do guard. Não sobrescreve — reporta override.
export function decidirDesfechoDeReset({ statusAtual }) {
  return statusAtual === 'PAUSED' ? 'REATIVAR' : 'MANUAL_OVERRIDE_DETECTED'
}
