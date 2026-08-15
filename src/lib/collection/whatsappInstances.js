// Central de Instâncias WhatsApp — seleção por prioridade/saúde + circuit breaker.
// Não decide O QUE enviar nem quando (isso é do dispatchEngine/régua) — só "qual
// instância está apta a enviar agora".
//
// Circuit breaker (configurável só nestas constantes por enquanto — expor na UI é
// trabalho futuro se a operação real pedir, não implementado especulativamente):
//   DEGRADED_AFTER_FAILURES falhas consecutivas seguidas -> health_status='degraded'
//   COOLDOWN_AFTER_FAILURES falhas consecutivas seguidas -> health_status='cooldown' por COOLDOWN_MINUTES
// Instância em 'cooldown' ou 'disabled' nunca é selecionada. Depois do cooldown
// expirar, ela volta a ser candidata (não auto-recupera para 'connected' sozinha —
// isso só acontece quando o healthcheck confirmar conexão de verdade).
import { supabase } from '../supabase-admin.server.js'

const DEGRADED_AFTER_FAILURES = 3
const COOLDOWN_AFTER_FAILURES = 6
const COOLDOWN_MINUTES = 30

// REGRA ABSOLUTA (C.3C) — vivenzza (comercial) e vivenzza-teste-cloud
// (contingência comercial) nunca podem ser usadas pelo pool financeiro. Hoje
// isso já é verdade na prática porque ninguém cadastrou essas instâncias em
// whatsapp_instances — mas nada no código impedia um cadastro futuro por
// engano de entrar no pool automaticamente. Guarda explícita, defesa em
// profundidade, sem depender só da disciplina operacional.
const INSTANCIAS_COMERCIAIS_PROIBIDAS = ['vivenzza', 'vivenzza-teste-cloud']

// BRT fixo (Brasil não observa DST desde 2019) — mesmo padrão de
// globalSendLimit.js/cobranca-whatsapp.js.
function inicioDoDiaBrtISO() {
  const hojeBrt = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  return `${hojeBrt}T03:00:00.000Z`
}

// 2026-08-15 — achado real (B1): whatsapp_instances.sent_today diverge da
// contagem real de envios porque (a) também soma dispatches purpose=
// 'internal_test' (homologação, nunca é cobrança de verdade) e (b) só
// reseta de forma PREGUIÇOSA (garantirContadoresDoDia roda como efeito
// colateral do próximo dispatch — se um dia passar sem nenhum envio, o
// contador fica travado no valor do último dia que teve envio, em vez de
// reflitir "0 hoje"). Pra qualquer decisão de LIMITE (instanciaApta), a
// fonte canônica agora é o envio real persistido — não o contador
// incremental. 2 queries (nunca N+1 por instância): pega os dispatches
// reais de hoje, depois as tentativas bem-sucedidas de hoje que apontam
// pra eles, agrupadas por instância.
export async function contarEnviosReaisHojePorInstancia() {
  const inicioDia = inicioDoDiaBrtISO()

  const { data: dispatches, error: erroDispatches } = await supabase
    .from('collection_dispatches')
    .select('id')
    .eq('purpose', 'collection')
    .gte('criado_em', inicioDia)
  if (erroDispatches) throw erroDispatches
  const idsReais = new Set((dispatches ?? []).map((d) => d.id))
  if (!idsReais.size) return new Map()

  const { data: tentativas, error: erroTentativas } = await supabase
    .from('collection_dispatch_attempts')
    .select('whatsapp_instance_id, status, dispatch_id, enviado_em')
    .in('status', ['sent', 'delivered', 'read'])
    .gte('enviado_em', inicioDia)
  if (erroTentativas) throw erroTentativas

  const contagem = new Map()
  for (const t of tentativas ?? []) {
    if (!t.whatsapp_instance_id || !idsReais.has(t.dispatch_id)) continue // exclui internal_test e qualquer coisa fora de hoje
    contagem.set(t.whatsapp_instance_id, (contagem.get(t.whatsapp_instance_id) ?? 0) + 1)
  }
  return contagem
}

async function garantirContadoresDoDia(instancia) {
  const hojeISO = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
  if (instancia.counters_reset_at === hojeISO) return instancia

  const { data, error } = await supabase
    .from('whatsapp_instances')
    .update({
      sent_today: 0, delivered_today: 0, failed_today: 0, read_today: 0, responses_today: 0,
      counters_reset_at: hojeISO,
    })
    .eq('id', instancia.id)
    .select()
    .single()
  if (error) throw error
  return data
}

// FASE C.2 (homologação, 2026-08-12) — achado real da revisão: ordenar só por
// priority não é deterministico entre réplicas/execuções quando duas
// instâncias empatam nesse valor (ex: backfill + cadastro manual futuro com o
// mesmo priority por engano) — quem "vence" dependia da ordem física das
// linhas no Postgres, não de uma regra. `id` como desempate secundário torna
// a seleção 100% determinística sempre. A garantia de que só existe 1
// principal HABILITADA por vez é a constraint idx_whatsapp_instances_unica_principal_ativa
// (banco, não JS) — ver migration 20260101000029.
export async function listarInstancias() {
  const { data, error } = await supabase.from('whatsapp_instances').select('*').order('priority', { ascending: true }).order('id', { ascending: true })
  if (error) throw error
  const comContadoresAtuais = []
  for (const instancia of data ?? []) comContadoresAtuais.push(await garantirContadoresDoDia(instancia))
  return comContadoresAtuais
}

function estaEmCooldown(instancia) {
  return instancia.health_status === 'cooldown' && instancia.cooldown_until && new Date(instancia.cooldown_until) > new Date()
}

// 2026-08-15 — `enviosReaisHoje` (Map instanciaId -> contagem) é a fonte
// canônica pro daily_limit (ver contarEnviosReaisHojePorInstancia acima) —
// nunca mais instancia.sent_today, que pode divergir (internal_test
// contaminando, ou reset preguiçoso deixando o valor travado num dia sem
// envio nenhum). Instância sem nenhuma linha no Map = 0 envios reais hoje.
function instanciaApta(instancia, enviosReaisHoje) {
  if (INSTANCIAS_COMERCIAIS_PROIBIDAS.includes(instancia.instance_name)) return false
  if (!instancia.enabled) return false
  if (instancia.health_status === 'disabled') return false
  if (estaEmCooldown(instancia)) return false
  const enviosHoje = enviosReaisHoje.get(instancia.id) ?? 0
  if (instancia.daily_limit != null && enviosHoje >= instancia.daily_limit) return false
  if (instancia.hourly_limit != null) {
    // Limite por hora por instância é aproximado por sent_today (contador diário) —
    // controle fino de janela horária por instância fica a cargo do limite GLOBAL
    // (automacoes_config.global_hourly_limit), que collectionRouting.js/
    // globalSendLimit.js já aplica de forma exata (ver PR #31).
    return true
  }
  return true
}

// Ordena por prioridade (menor = preferida) entre as aptas; instâncias excluídas
// (ex: já tentadas neste dispatch) nunca voltam a ser escolhidas no mesmo ciclo de
// tentativas — evita re-tentar a mesma instância que acabou de falhar.
export async function selecionarProximaInstancia({ excluirIds = [] } = {}) {
  const [instancias, enviosReaisHoje] = await Promise.all([listarInstancias(), contarEnviosReaisHojePorInstancia()])
  const candidatas = instancias
    .filter((i) => !excluirIds.includes(i.id))
    .filter((i) => instanciaApta(i, enviosReaisHoje))
    .sort((a, b) => a.priority - b.priority)
  return candidatas[0] ?? null
}

export async function registrarSucessoEnvio(instanciaId) {
  const { data: instancia, error: errBusca } = await supabase.from('whatsapp_instances').select('*').eq('id', instanciaId).single()
  if (errBusca) throw errBusca
  const atual = await garantirContadoresDoDia(instancia)

  const { error } = await supabase
    .from('whatsapp_instances')
    .update({
      consecutive_failures: 0,
      health_status: 'connected',
      last_success_at: new Date().toISOString(),
      sent_today: atual.sent_today + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', instanciaId)
  if (error) throw error
}

export async function registrarFalhaEnvio(instanciaId) {
  const { data: instancia, error: errBusca } = await supabase.from('whatsapp_instances').select('*').eq('id', instanciaId).single()
  if (errBusca) throw errBusca
  const atual = await garantirContadoresDoDia(instancia)

  const falhas = atual.consecutive_failures + 1
  let healthStatus = atual.health_status === 'connected' || atual.health_status === 'unknown' ? 'degraded' : atual.health_status
  let cooldownUntil = atual.cooldown_until

  if (falhas >= COOLDOWN_AFTER_FAILURES) {
    healthStatus = 'cooldown'
    cooldownUntil = new Date(Date.now() + COOLDOWN_MINUTES * 60 * 1000).toISOString()
  } else if (falhas >= DEGRADED_AFTER_FAILURES) {
    healthStatus = 'degraded'
  }

  const { error } = await supabase
    .from('whatsapp_instances')
    .update({
      consecutive_failures: falhas,
      health_status: healthStatus,
      cooldown_until: cooldownUntil,
      last_failure_at: new Date().toISOString(),
      failed_today: atual.failed_today + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', instanciaId)
  if (error) throw error

  return { healthStatus, falhas }
}

// 2026-08-15 — achado real (B3): o comentário abaixo sempre afirmou que
// 'open' só vira 'connected' se não estiver em cooldown, mas o código nunca
// checou isso — fazia UPDATE incondicional. Com o healthcheck rodando a
// cada 15min (evolution-health.js) e COOLDOWN_MINUTES=30, isso podia furar
// o circuit breaker pela metade do tempo: a Evolution respondendo "open"
// (conectividade física real) reescrevia health_status='connected' mesmo
// com cooldown_until ainda no futuro, e estaEmCooldown() (que checa
// health_status==='cooldown' AND cooldown_until>now) passava a devolver
// false antes da hora. Corrigido: connection_status (conectividade física)
// sempre reflete a realidade; health_status (estado do circuit breaker) só
// é tocado quando NÃO há cooldown ativo — cooldown só termina por tempo,
// nunca por um healthcheck isolado responder bem.
export async function atualizarStatusConexao(instanceName, connectionStatus) {
  const { data: atual, error: erroBusca } = await supabase
    .from('whatsapp_instances')
    .select('health_status, cooldown_until')
    .eq('instance_name', instanceName)
    .maybeSingle()
  if (erroBusca) throw erroBusca
  if (!atual) return // instância não cadastrada (ex: comercial) — nada a atualizar

  const emCooldownAtivo = atual.health_status === 'cooldown' && atual.cooldown_until && new Date(atual.cooldown_until) > new Date()

  const campos = {
    connection_status: connectionStatus,
    last_connection_update: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  if (!emCooldownAtivo) {
    campos.health_status = connectionStatus === 'open' ? 'connected' : 'disconnected'
  }

  const { error } = await supabase.from('whatsapp_instances').update(campos).eq('instance_name', instanceName)
  if (error) throw error
}

export async function desabilitarInstancia(instanceId, motivo) {
  const { error } = await supabase
    .from('whatsapp_instances')
    .update({ enabled: false, health_status: 'disabled', updated_at: new Date().toISOString() })
    .eq('id', instanceId)
  if (error) throw error
  return { motivo }
}
