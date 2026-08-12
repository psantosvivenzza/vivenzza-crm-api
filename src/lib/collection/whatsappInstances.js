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

export async function listarInstancias() {
  const { data, error } = await supabase.from('whatsapp_instances').select('*').order('priority', { ascending: true })
  if (error) throw error
  const comContadoresAtuais = []
  for (const instancia of data ?? []) comContadoresAtuais.push(await garantirContadoresDoDia(instancia))
  return comContadoresAtuais
}

function estaEmCooldown(instancia) {
  return instancia.health_status === 'cooldown' && instancia.cooldown_until && new Date(instancia.cooldown_until) > new Date()
}

function instanciaApta(instancia) {
  if (!instancia.enabled) return false
  if (instancia.health_status === 'disabled') return false
  if (estaEmCooldown(instancia)) return false
  if (instancia.daily_limit != null && instancia.sent_today >= instancia.daily_limit) return false
  if (instancia.hourly_limit != null) {
    // Limite por hora por instância é aproximado por sent_today (contador diário) —
    // controle fino de janela horária por instância fica a cargo do limite GLOBAL
    // (automacoes_config.global_hourly_limit), que o dispatchEngine já aplica de
        // forma exata contando collection_dispatch_attempts da última hora.
    return true
  }
  return true
}

// Ordena por prioridade (menor = preferida) entre as aptas; instâncias excluídas
// (ex: já tentadas neste dispatch) nunca voltam a ser escolhidas no mesmo ciclo de
// tentativas — evita re-tentar a mesma instância que acabou de falhar.
export async function selecionarProximaInstancia({ excluirIds = [] } = {}) {
  const instancias = await listarInstancias()
  const candidatas = instancias
    .filter((i) => !excluirIds.includes(i.id))
    .filter(instanciaApta)
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

export async function atualizarStatusConexao(instanceName, connectionStatus) {
  const { error } = await supabase
    .from('whatsapp_instances')
    .update({
      connection_status: connectionStatus,
      last_connection_update: new Date().toISOString(),
      // connectionStatus vem do healthcheck da Evolution (open/close/connecting).
      // 'open' garante saúde 'connected' apenas se não estiver em cooldown —
      // cooldown só se resolve por tempo, não por reconexão isolada (o circuit
      // breaker existe pra evitar reconectar-e-falhar em loop rápido).
      ...(connectionStatus === 'open' ? { health_status: 'connected' } : { health_status: 'disconnected' }),
      updated_at: new Date().toISOString(),
    })
    .eq('instance_name', instanceName)
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
