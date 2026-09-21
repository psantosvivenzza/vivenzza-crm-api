// Voice AI EXTERNAL PILOT READINESS — guardrails PUROS (sem rede/ARI/DB
// aqui) que qualquer futura chamada externa precisará passar TODOS antes de
// originar. Cada função recebe o estado necessário como parâmetro — nunca
// consulta nada sozinha — pra ser 100% testável sem infraestrutura real.
//
// Regra de composição: `avaliarAutorizacaoChamadaExterna` roda TODOS os
// checks e só autoriza se TODOS passarem. Sem flag + allowlist, nunca
// origina — mesmo que todo o resto esteja correto.
import { TIPO_DESTINO, resolverDestino } from './destinoResolver.js'
import { lerConfigNvoip } from './externalConfig.js'

export function avaliarFlagExternalHabilitada(flags) {
  return flags?.voice_external_enabled === true
}

// ACHADO REAL (21/09/2026, auditoria do kill switch): desde que
// TRUNK_EXTERNO_CONFIGURADO passou a `true` em destinoResolver.js
// (2026-09-16, adapter Nvoip implementado), `resolverDestino(EXTERNAL)`
// NUNCA MAIS lança — o try/catch abaixo, que era a trava real de "sem
// trunk configurado", virou código morto. Sem este check, flag=true no
// banco + allowlist OK já bastava pra `avaliarAutorizacaoChamadaExterna`
// devolver permitido=true mesmo sem nenhuma credencial/servidor SIP real
// configurado — a checagem de prontidão do trunk só sobrevivia rio abaixo,
// em `construirPayloadOriginateExterno` (outboundExternalTest.js), que nem
// todo chamador desta função necessariamente invoca antes de decidir.
// Esta função restaura a checagem de prontidão do trunk NESTA camada
// central de autorização — mesmo critério (NVOIP_SIP_SERVER presente) já
// usado por construirPayloadOriginateExterno, só que fail-closed mais cedo.
export function avaliarTrunkPronto(configNvoip) {
  return Boolean(configNvoip?.sipServer)
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

export const TIMEZONE_COBRANCA = 'America/Sao_Paulo'

// BUG REAL corrigido em 2026-09-17: esta função usava getDay()/getHours() do
// relógio LOCAL do processo. Num servidor em UTC (o caso normal em nuvem),
// 18:00 BRT é 21:00 UTC — o guard achava que estava fora da janela e
// bloqueava ligações legítimas; pior, 06:00 BRT é 09:00 UTC e ele
// AUTORIZARIA uma ligação às 6 da manhã, fora da janela legal estadual.
// Agora a hora é sempre resolvida em horário de Brasília, independente do
// fuso onde o processo roda. Mesmo princípio de hojeBrtISO() em
// collectionContactPolicy.js, mas via Intl — que também acerta a virada do
// dia, que a aritmética de UTC-3 não cobria.
export function partesHorarioBrt(data) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: TIMEZONE_COBRANCA,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(data)
      .map((parte) => [parte.type, parte.value]),
  )
  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  // hour12:false devolve '24' à meia-noite em alguns runtimes — normaliza.
  const hora = Number(partes.hour) % 24
  return { diaSemana: DIAS[partes.weekday], minutoDoDia: hora * 60 + Number(partes.minute) }
}

// Fail-closed por padrão: sem política explícita com pelo menos uma janela,
// NUNCA autoriza — não herda horário comercial "padrão" às cegas.
export function avaliarHorarioPermitido(horaAtual, politica) {
  if (!politica || !Array.isArray(politica.janelas) || politica.janelas.length === 0) return false
  const { diaSemana, minutoDoDia } = partesHorarioBrt(horaAtual)
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

// 2026-08-16 — prontidão SIP trunk externo (Nvoip): teto GLOBAL (soma de
// TODAS as chamadas externas, não só por telefone) — item 7 do pedido
// ("trocar provider/trunk nunca pode resetar limite global lógico").
// Deliberadamente NÃO adicionados a avaliarAutorizacaoChamadaExterna() acima
// (função já testada e composta; estender a assinatura dela arriscaria
// quebrar chamadores existentes) — quem orquestra uma futura chamada real
// deve chamar estas duas funções TAMBÉM, além daquela. Mesmo fail-closed:
// limite<=0 nunca autoriza.
export function avaliarLimiteGlobalPorHora(chamadasUltimaHora, limitePorHora) {
  if (!(limitePorHora > 0)) return false
  const contagem = Array.isArray(chamadasUltimaHora) ? chamadasUltimaHora.length : 0
  return contagem < limitePorHora
}

export function avaliarLimiteGlobalPorDia(chamadasHojeGlobal, limitePorDia) {
  if (!(limitePorDia > 0)) return false
  const contagem = Array.isArray(chamadasHojeGlobal) ? chamadasHojeGlobal.length : 0
  return contagem < limitePorDia
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
  if (!avaliarTrunkPronto(lerConfigNvoip())) {
    return { permitido: false, motivo: 'sem_trunk: NVOIP_SIP_SERVER não configurado — trunk SIP não está pronto para originar' }
  }
  if (!avaliarFlagExternalHabilitada(flags)) return { permitido: false, motivo: 'flag_desabilitada: voice_external_enabled não está true' }
  if (!avaliarNumeroNaAllowlist(numero, allowlist)) return { permitido: false, motivo: `fora_da_allowlist: "${numero}" não está na allowlist de teste` }
  if (!avaliarIdempotencia(idempotencyKey, chavesJaProcessadas)) return { permitido: false, motivo: `idempotencia: chave "${idempotencyKey}" já foi processada` }
  if (!avaliarChamadaDuplicadaAtiva(numero, chamadasAtivas)) return { permitido: false, motivo: `chamada_ja_ativa: já existe uma chamada em andamento para "${numero}"` }
  if (!avaliarHorarioPermitido(horaAtual, politicaHorario)) return { permitido: false, motivo: 'fora_do_horario: nenhuma janela permitida cobre o horário atual (fail-closed sem política configurada)' }
  if (!avaliarLimiteDiarioPorTelefone(numero, chamadasHoje, limiteDiario)) return { permitido: false, motivo: `limite_diario_excedido: "${numero}" já atingiu o limite de chamadas hoje` }
  return { permitido: true, motivo: null }
}
