// Testes puros + DRY RUN simulado do hard-cap de spend do Meta Ads (mesmo
// padrão de scripts/teste-collection-motor-puro.mjs — checks simples, sem
// framework, sem rede/banco real).
//
// Precisa de SUPABASE_URL/SUPABASE_SECRET_KEY no ambiente com valores fictícios
// (nenhuma função aqui faz query de verdade — todo I/O é injetado via `deps` —
// mas src/jobs/meta-budget-guard.js importa supabase-admin.server.js no topo,
// que valida essas variáveis já na importação). Rode com:
//   SUPABASE_URL=http://localhost:54321 SUPABASE_SECRET_KEY=dummy node scripts/teste-meta-budget-guard.mjs
import {
  decidirNivel, diaContaBrt, pausasPendentesDeReativacao, decidirDesfechoDeReset,
  LIMIAR_ALERTA_PADRAO, LIMIAR_PROTECAO_PADRAO,
} from '../src/lib/metaBudgetGuard.js'
import { runMetaBudgetGuard } from '../src/jobs/meta-budget-guard.js'

let falhas = 0
function check(nome, cond, detalhe) {
  if (cond) console.log(`OK — ${nome}`)
  else { falhas++; console.log(`FALHOU — ${nome}${detalhe ? ' — ' + detalhe : ''}`) }
}

// ── 1) decidirNivel — thresholds atuais: alerta R$115, proteção R$125 ───
check('limiares padrão são 115/125', LIMIAR_ALERTA_PADRAO === 115 && LIMIAR_PROTECAO_PADRAO === 125)
check('spend=114 -> NENHUMA', decidirNivel({ spend: 114 }) === 'NENHUMA')
check('spend=115 -> ALERTA', decidirNivel({ spend: 115 }) === 'ALERTA')
check('spend=124 -> ALERTA', decidirNivel({ spend: 124 }) === 'ALERTA')
check('spend=125 -> PROTECAO', decidirNivel({ spend: 125 }) === 'PROTECAO')
check('spend=135 -> PROTECAO', decidirNivel({ spend: 135 }) === 'PROTECAO')
check('API falhou (spend=NaN) -> NENHUMA', decidirNivel({ spend: NaN }) === 'NENHUMA')
check('API falhou (spend=undefined) -> NENHUMA', decidirNivel({ spend: undefined }) === 'NENHUMA')
check('threshold customizado respeitado (spend=100, alerta=90) -> ALERTA', decidirNivel({ spend: 100, alertaThreshold: 90, protecaoThreshold: 200 }) === 'ALERTA')

// ── 2) diaContaBrt — usa timezone da conta, não UTC nem local ───────────
const instanteNoturno = new Date('2026-08-11T02:30:00Z')
check(
  'diaContaBrt usa timezone da conta (23:30 BRT ainda é dia anterior em UTC)',
  diaContaBrt(instanteNoturno, 'America/Sao_Paulo') === '2026-08-10'
)

// ── 3) decidirDesfechoDeReset — status atual manda ───────────────────────
check('status PAUSED -> REATIVAR', decidirDesfechoDeReset({ statusAtual: 'PAUSED' }) === 'REATIVAR')
check('status ACTIVE (alguém reativou manualmente) -> MANUAL_OVERRIDE_DETECTED', decidirDesfechoDeReset({ statusAtual: 'ACTIVE' }) === 'MANUAL_OVERRIDE_DETECTED')
check('status DELETED -> MANUAL_OVERRIDE_DETECTED (nunca sobrescreve)', decidirDesfechoDeReset({ statusAtual: 'DELETED' }) === 'MANUAL_OVERRIDE_DETECTED')

// ── 4) pausasPendentesDeReativacao ───────────────────────────────────────
const logs = [
  { id: 'p1', entity_id: 'camp-A', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-10' },
  { id: 'p2', entity_id: 'camp-B', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-10' },
  { id: 'r1', entity_id: 'camp-B', entity_type: 'campaign', action: 'resumed', dia_conta: '2026-08-11', pause_action_id: 'p2' },
  { id: 'p3', entity_id: 'camp-C', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-08' }, // pausada há 3 dias, nunca resolvida (gap de cron)
  { id: 'p4', entity_id: 'camp-E', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-10' },
  { id: 'o1', entity_id: 'camp-E', entity_type: 'campaign', action: 'manual_override', dia_conta: '2026-08-11', pause_action_id: 'p4' },
]
const pendentes = pausasPendentesDeReativacao({ logsAnteriores: logs, diaContaAtual: '2026-08-11' })
check('camp-A (pausada ontem, sem resolução) está pendente', pendentes.some((p) => p.entity_id === 'camp-A'))
check('camp-B (pausada ontem, já resumida) NÃO está pendente', !pendentes.some((p) => p.entity_id === 'camp-B'))
check('camp-C (pausada há 3 dias, gap de cron) continua pendente — self-healing', pendentes.some((p) => p.entity_id === 'camp-C'))
check('camp-E (pausada ontem, override manual detectado) NÃO está pendente — não insiste', !pendentes.some((p) => p.entity_id === 'camp-E'))

const logsHoje = [{ id: 'p5', entity_id: 'camp-D', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-11' }]
const pendentesHoje = pausasPendentesDeReativacao({ logsAnteriores: logsHoje, diaContaAtual: '2026-08-11' })
check('pausa do PRÓPRIO dia corrente não é reativada (só dia_conta < atual)', pendentesHoje.length === 0)

// ── 5) DRY RUN da orquestração completa (deps injetados, zero rede/banco) ──
function criarFakeStore(logsIniciais = []) {
  const logsGravados = []
  return {
    logsGravados,
    async lerLogsAnteriores(diaContaAtual) {
      return [...logsIniciais, ...logsGravados].filter((l) => l.dia_conta < diaContaAtual)
    },
    async jaExisteLog({ entity_id, entity_type, action, dia_conta }) {
      return [...logsIniciais, ...logsGravados].some(
        (l) => l.entity_id === entity_id && l.entity_type === entity_type && l.action === action && l.dia_conta === dia_conta
      )
    },
    async registrarLog(linha) {
      logsGravados.push({ id: `fake-${logsGravados.length}`, ...linha })
      return true
    },
  }
}

function criarFakeMeta({ campanhasAtivas = [], falharPause = false, falharResume = false, statusAoChecar = 'PAUSED', falharTimezone = false } = {}) {
  const chamadas = { pausarCampanha: [], reativarCampanha: [], obterStatusCampanha: [] }
  return {
    chamadas,
    async obterTimezoneConta() {
      if (falharTimezone) throw new Error('timeout simulado ao ler timezone da conta')
      return 'America/Sao_Paulo'
    },
    async lerSpendHoje() { throw new Error('lerSpendHoje não deveria ser chamado diretamente — sobrescreva por cenário') },
    async listarCampanhasAtivas() { return campanhasAtivas },
    async obterStatusCampanha(id) {
      chamadas.obterStatusCampanha.push(id)
      return { id, effective_status: statusAoChecar }
    },
    async pausarCampanha(id) {
      chamadas.pausarCampanha.push(id)
      if (falharPause) throw new Error('erro simulado da Graph API')
    },
    async reativarCampanha(id) {
      chamadas.reativarCampanha.push(id)
      if (falharResume) throw new Error('erro simulado da Graph API')
    },
  }
}

const configBase = {
  meta_budget_guard_enabled: true,
  meta_budget_guard_dry_run: true,
  meta_budget_guard_alert_threshold: 115,
  meta_budget_guard_protect_threshold: 125,
  meta_budget_guard_hard_cap: 150,
}

async function simular(spend, { configOverrides = {}, metaOverrides = {} } = {}) {
  const notificacoes = []
  const meta = criarFakeMeta({ campanhasAtivas: [{ id: 'camp-X', name: 'Campanha X', effective_status: 'ACTIVE' }], ...metaOverrides })
  meta.lerSpendHoje = async () => {
    if (spend === 'FALHA') throw new Error('timeout simulado da Insights API')
    return spend
  }
  const store = criarFakeStore()
  const resultado = await runMetaBudgetGuard({
    config: { ...configBase, ...configOverrides },
    store,
    metaClient: meta,
    notificar: async (msg) => notificacoes.push(msg),
    agora: new Date('2026-08-11T15:00:00Z'),
  })
  return { resultado, notificacoes, store, meta }
}

// meta_budget_guard_enabled=false -> pulado, nada acontece
{
  const { resultado } = await simular(135, { configOverrides: { meta_budget_guard_enabled: false } })
  check('enabled=false -> pulado inteiro', resultado.pulado === true)
}

// spend=114 -> nenhuma ação
{
  const { resultado, notificacoes, meta } = await simular(114)
  check('DRY RUN spend=114 -> nivel NENHUMA', resultado.nivel === 'NENHUMA')
  check('DRY RUN spend=114 -> nenhuma notificação', notificacoes.length === 0)
  check('DRY RUN spend=114 -> nenhuma chamada de pause/resume na Graph API', meta.chamadas.pausarCampanha.length === 0)
}

// spend=115 -> ALERTA, dry run não manda WhatsApp
{
  const { resultado, notificacoes, store } = await simular(115)
  check('DRY RUN spend=115 -> nivel ALERTA', resultado.nivel === 'ALERTA')
  check('DRY RUN spend=115 -> notificação NÃO enviada (dry_run=true)', notificacoes.length === 0)
  check('DRY RUN spend=115 -> log de alerta gravado mesmo em dry run', store.logsGravados.some((l) => l.action === 'alerted'))
}

// spend=124 -> ALERTA (ainda não protege)
{
  const { resultado } = await simular(124)
  check('DRY RUN spend=124 -> nivel ALERTA (abaixo de 125)', resultado.nivel === 'ALERTA')
}

// spend=125 -> PROTECAO, reason literal DAILY_BUDGET_GUARD
{
  const { resultado, meta, store } = await simular(125)
  check('DRY RUN spend=125 -> nivel PROTECAO', resultado.nivel === 'PROTECAO')
  check('DRY RUN spend=125 -> NÃO chama pausarCampanha de verdade (dry_run=true)', meta.chamadas.pausarCampanha.length === 0)
  check('DRY RUN spend=125 -> loga a pausa com reason DAILY_BUDGET_GUARD', store.logsGravados.some((l) => l.action === 'paused' && l.reason.includes('DAILY_BUDGET_GUARD')))
  check('DRY RUN spend=125 -> pausadasAgora reporta a campanha (mesmo sem chamar API)', resultado.pausadasAgora.some((p) => p.id === 'camp-X'))
}

// spend=135 -> PROTECAO
{
  const { resultado } = await simular(135)
  check('DRY RUN spend=135 -> nivel PROTECAO', resultado.nivel === 'PROTECAO')
}

// API falhou (leitura de spend) -> nenhuma alteração, nenhuma escrita de log de ação
{
  const { resultado, store, meta } = await simular('FALHA')
  check('API falhou (spend) -> retorna erro leitura_spend_falhou', resultado.erro === 'leitura_spend_falhou')
  check('API falhou (spend) -> nenhum log de alerted/paused gravado', !store.logsGravados.some((l) => ['alerted', 'paused'].includes(l.action)))
  check('API falhou (spend) -> nenhuma chamada de escrita na Graph API', meta.chamadas.pausarCampanha.length === 0 && meta.chamadas.reativarCampanha.length === 0)
}

// ── 6) Fail-safe: timezone indeterminado -> NÃO agir ─────────────────────
{
  const { resultado, store, meta } = await simular(135, { metaOverrides: { falharTimezone: true } })
  check('Timezone indeterminado -> retorna erro timezone_indeterminado', resultado.erro === 'timezone_indeterminado')
  check('Timezone indeterminado -> nenhum log gravado', store.logsGravados.length === 0)
  check('Timezone indeterminado -> nenhuma chamada de escrita na Graph API', meta.chamadas.pausarCampanha.length === 0 && meta.chamadas.reativarCampanha.length === 0)
}

// ── 7) Fail-safe: banco falhou ao ler log de pausas -> NÃO agir ──────────
{
  const notificacoes = []
  const meta = criarFakeMeta({ campanhasAtivas: [{ id: 'camp-X', name: 'Campanha X', effective_status: 'ACTIVE' }] })
  meta.lerSpendHoje = async () => 135
  const storeQuebrado = {
    async lerLogsAnteriores() { throw new Error('conexão com Supabase falhou') },
    async jaExisteLog() { return false },
    async registrarLog() { return true },
  }
  const resultado = await runMetaBudgetGuard({
    config: configBase, store: storeQuebrado, metaClient: meta,
    notificar: async (msg) => notificacoes.push(msg),
    agora: new Date('2026-08-11T15:00:00Z'),
  })
  check('Banco falhou (leitura de log) -> retorna erro leitura_log_falhou', resultado.erro === 'leitura_log_falhou')
  check('Banco falhou (leitura de log) -> nenhuma chamada de escrita na Graph API', meta.chamadas.pausarCampanha.length === 0 && meta.chamadas.reativarCampanha.length === 0)
  check('Banco falhou (leitura de log) -> nenhuma notificação enviada', notificacoes.length === 0)
}

// ── 8) Modo REAL (dry_run=false) — confirma que aí sim a Graph API é chamada,
//      e que a mensagem tem spend, %, horário e campanhas ativas ────────────
{
  const notificacoes = []
  const meta = criarFakeMeta({ campanhasAtivas: [{ id: 'camp-X', name: 'Campanha X', effective_status: 'ACTIVE' }] })
  meta.lerSpendHoje = async () => 135
  const store = criarFakeStore()
  const resultado = await runMetaBudgetGuard({
    config: { ...configBase, meta_budget_guard_dry_run: false },
    store, metaClient: meta,
    notificar: async (msg) => notificacoes.push(msg),
    agora: new Date('2026-08-11T15:00:00Z'),
  })
  check('MODO REAL spend=135 -> chama pausarCampanha de verdade', meta.chamadas.pausarCampanha.includes('camp-X'))
  check('MODO REAL spend=135 -> manda WhatsApp de alerta E de proteção', notificacoes.length === 2)
  check('MODO REAL -> mensagem de alerta cita spend em R$', notificacoes[0].includes('R$135.00') || notificacoes[0].includes('R$135,00') || notificacoes[0].includes('135.00'))
  check('MODO REAL -> mensagem de alerta cita percentual do teto (90.0%)', notificacoes[0].includes('90.0%'))
  check('MODO REAL -> mensagem de alerta cita campanhas ativas', notificacoes[0].includes('Campanha X'))
  check('MODO REAL -> mensagem de proteção cita as pausadas', notificacoes[1].includes('Campanha X'))
  check('MODO REAL spend=135 -> log gravado sem "[DRY RUN]" na razão', store.logsGravados.find((l) => l.action === 'paused').reason === 'DAILY_BUDGET_GUARD')
}

// ── 9) Falha de escrita na Meta (modo real) — registra erro e alerta, não quebra ──
{
  const notificacoes = []
  const meta = criarFakeMeta({ campanhasAtivas: [{ id: 'camp-X', name: 'Campanha X', effective_status: 'ACTIVE' }], falharPause: true })
  meta.lerSpendHoje = async () => 135
  const store = criarFakeStore()
  const resultado = await runMetaBudgetGuard({
    config: { ...configBase, meta_budget_guard_dry_run: false },
    store, metaClient: meta,
    notificar: async (msg) => notificacoes.push(msg),
    agora: new Date('2026-08-11T15:00:00Z'),
  })
  check('Falha de escrita -> pausadasAgora fica vazio', resultado.pausadasAgora.length === 0)
  check('Falha de escrita -> grava log write_failed', store.logsGravados.some((l) => l.action === 'write_failed'))
  check('Falha de escrita -> manda alerta de falha (FALHA ao pausar)', notificacoes.some((m) => m.includes('FALHA ao pausar')))
}

// ── 10) Reset do dia seguinte — reativa só o que o próprio guard pausou ────
{
  const notificacoes = []
  const meta = criarFakeMeta({ campanhasAtivas: [], statusAoChecar: 'PAUSED' })
  meta.lerSpendHoje = async () => 50 // dia novo, spend baixo, sem nova ação de proteção
  const store = criarFakeStore([
    { id: 'p-ontem', entity_id: 'camp-Y', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-10', status_before_guard: 'ACTIVE' },
  ])
  const resultado = await runMetaBudgetGuard({
    config: { ...configBase, meta_budget_guard_dry_run: false },
    store, metaClient: meta,
    notificar: async (msg) => notificacoes.push(msg),
    agora: new Date('2026-08-11T15:00:00Z'), // dia seguinte
  })
  check('Reset -> checa status atual antes de reativar', meta.chamadas.obterStatusCampanha.includes('camp-Y'))
  check('Reset -> reativa campanha pausada no dia anterior (status ainda PAUSED)', meta.chamadas.reativarCampanha.includes('camp-Y'))
  check('Reset -> resultado.reativadas reporta camp-Y', resultado.reativadas.some((r) => r.entity_id === 'camp-Y'))
  check('Reset -> log resumed gravado com pause_action_id correto', store.logsGravados.some((l) => l.action === 'resumed' && l.pause_action_id === 'p-ontem'))
}

// ── 11) Proteção contra intervenção humana — MANUAL_OVERRIDE_DETECTED ──────
{
  const notificacoes = []
  // statusAoChecar='ACTIVE' simula alguém tendo reativado manualmente depois da
  // pausa do guard — a campanha NÃO deveria estar PAUSED como o guard esperava.
  const meta = criarFakeMeta({ campanhasAtivas: [], statusAoChecar: 'ACTIVE' })
  meta.lerSpendHoje = async () => 50
  const store = criarFakeStore([
    { id: 'p-manual', entity_id: 'camp-Z', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-10', status_before_guard: 'ACTIVE' },
  ])
  const resultado = await runMetaBudgetGuard({
    config: { ...configBase, meta_budget_guard_dry_run: false },
    store, metaClient: meta,
    notificar: async (msg) => notificacoes.push(msg),
    agora: new Date('2026-08-11T15:00:00Z'),
  })
  check('Override manual -> NÃO chama reativarCampanha (não sobrescreve)', !meta.chamadas.reativarCampanha.includes('camp-Z'))
  check('Override manual -> resultado.overridesDetectados reporta camp-Z', resultado.overridesDetectados.some((o) => o.entity_id === 'camp-Z'))
  check('Override manual -> log manual_override gravado com reason MANUAL_OVERRIDE_DETECTED', store.logsGravados.some((l) => l.action === 'manual_override' && l.reason.includes('MANUAL_OVERRIDE_DETECTED')))
  check('Override manual -> resolve a pausa (não fica pendente pra sempre)', pausasPendentesDeReativacao({
    logsAnteriores: [...store.logsGravados, { id: 'p-manual', entity_id: 'camp-Z', entity_type: 'campaign', action: 'paused', dia_conta: '2026-08-10' }],
    diaContaAtual: '2026-08-12',
  }).length === 0)
}

console.log(`\n${falhas === 0 ? 'TODOS OS TESTES PASSARAM' : `${falhas} TESTE(S) FALHARAM`}`)
process.exit(falhas === 0 ? 0 : 1)
