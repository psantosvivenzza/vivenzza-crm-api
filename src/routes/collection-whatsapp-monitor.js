// FASE C.1 (homologação, 2026-08-11) — API de LEITURA para o painel
// Financeiro → Cobranças → WhatsApps. Só GET. Nenhuma rota aqui cria, edita,
// desabilita instância, dispara mensagem ou muta qualquer coisa — isso é
// deliberado: a superfície administrativa (CRUD de instâncias, já escrita em
// src/routes/whatsapp-instances.js) fica FORA desta PR por pedido explícito
// de reduzir risco nesta fase ("não criar botão ativar failover/enviar
// teste/trocar principal"). Nunca retorna api_key/api_key_env_var VALOR — só
// o nome da env var (nunca o segredo em si, que nem passa pelo Postgres).
import { Router } from 'express'
import { supabase } from '../lib/supabase-admin.server.js'
import { listarInstancias } from '../lib/collection/whatsappInstances.js'

const router = Router()

// circuit_state é DERIVADO em tempo de leitura (não persistido) — função pura
// de health_status + cooldown_until + agora. Evita um campo que pode ficar
// obsoleto (ex: cooldown expira mas ninguém escreveu no registro ainda) e
// corresponde 1:1 à mesma lógica que já decide seleção em whatsappInstances.js
// (estaEmCooldown/instanciaApta) — nunca pode divergir do que o motor realmente usa.
function circuitStateDe(instancia) {
  if (instancia.health_status !== 'cooldown') return 'CLOSED'
  const aindaEmCooldown = instancia.cooldown_until && new Date(instancia.cooldown_until) > new Date()
  return aindaEmCooldown ? 'OPEN' : 'HALF_OPEN'
}

// Vocabulário público pedido (UNKNOWN/HEALTHY/DEGRADED/UNHEALTHY) — mapeado a
// partir do vocabulário interno mais granular (connected/disconnected/
// degraded/cooldown/disabled/error/unknown), que continua controlando a
// árvore de decisão real em whatsappInstances.js sem mudança de
// comportamento. Ter os dois nomes é intencional: interno = o que decide
// seleção; público = o que a UI mostra.
function healthStatusPublico(instancia) {
  if (!instancia.enabled) return 'UNHEALTHY'
  switch (instancia.health_status) {
    case 'connected': return 'HEALTHY'
    case 'degraded': return 'DEGRADED'
    case 'cooldown': return 'DEGRADED'
    case 'disconnected':
    case 'disabled':
    case 'error': return 'UNHEALTHY'
    default: return 'UNKNOWN'
  }
}

function instanciaPublica(instancia) {
  return {
    id: instancia.id,
    name: instancia.name,
    instance_name: instancia.instance_name,
    role: instancia.role,
    priority: instancia.priority,
    enabled: instancia.enabled,
    connection_status: instancia.connection_status,
    health_status: healthStatusPublico(instancia),
    circuit_state: circuitStateDe(instancia),
    consecutive_failures: instancia.consecutive_failures,
    last_success_at: instancia.last_success_at,
    last_failure_at: instancia.last_failure_at,
    last_connection_update: instancia.last_connection_update,
    cooldown_until: instancia.cooldown_until,
    daily_limit: instancia.daily_limit,
    hourly_limit: instancia.hourly_limit,
    sent_today: instancia.sent_today,
    delivered_today: instancia.delivered_today,
    failed_today: instancia.failed_today,
    read_today: instancia.read_today,
    responses_today: instancia.responses_today,
    // Deliberadamente OMITIDOS: api_base_url, api_key_env_var — mesmo não
    // sendo o segredo em si, não há necessidade de expor pra UI de leitura.
  }
}

router.get('/instances', async (req, res) => {
  try {
    const instancias = await listarInstancias()
    res.json(instancias.map(instanciaPublica))
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

router.get('/metrics', async (req, res) => {
  try {
    const instancias = await listarInstancias()
    const inicioDiaISO = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z'

    const [{ count: dispatchesHoje }, { data: dispatchesComMultiplasTentativas }] = await Promise.all([
      supabase.from('collection_dispatches').select('id', { count: 'exact', head: true }).gte('criado_em', inicioDiaISO),
      supabase.from('collection_dispatch_attempts').select('dispatch_id, attempt_number').gte('criado_em', inicioDiaISO).gt('attempt_number', 1),
    ])

    res.json({
      instancias_total: instancias.length,
      instancias_saudaveis: instancias.filter((i) => healthStatusPublico(i) === 'HEALTHY').length,
      instancias_degradadas: instancias.filter((i) => healthStatusPublico(i) === 'DEGRADED').length,
      circuitos_abertos: instancias.filter((i) => circuitStateDe(i) === 'OPEN').length,
      envios_hoje: instancias.reduce((soma, i) => soma + (i.sent_today ?? 0), 0),
      falhas_hoje: instancias.reduce((soma, i) => soma + (i.failed_today ?? 0), 0),
      dispatches_hoje: dispatchesHoje ?? 0,
      // "Failover hoje" = dispatches lógicos distintos com mais de 1 tentativa
      // hoje — cada dispatch conta 1x, não por tentativa extra.
      failovers_hoje: new Set((dispatchesComMultiplasTentativas ?? []).map((a) => a.dispatch_id)).size,
    })
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

// Histórico recente de tentativas — junta attempts + o dispatch pai (sem N+1:
// 1 query nas tentativas mais recentes, 1 query nos dispatches referenciados).
router.get('/attempts', async (req, res) => {
  try {
    const limite = Math.min(Number(req.query.limit) || 50, 200)
    const { data: tentativas, error: e1 } = await supabase
      .from('collection_dispatch_attempts')
      .select('id, dispatch_id, attempt_number, whatsapp_instance_id, status, failure_kind, provider_message_id, enviado_em, entregue_em, lido_em, falhou_em, criado_em')
      .order('criado_em', { ascending: false })
      .limit(limite)
    if (e1) throw e1

    const dispatchIds = [...new Set((tentativas ?? []).map((t) => t.dispatch_id))]
    const instanceIds = [...new Set((tentativas ?? []).map((t) => t.whatsapp_instance_id).filter(Boolean))]

    const [{ data: dispatches, error: e2 }, { data: instancias, error: e3 }] = await Promise.all([
      dispatchIds.length ? supabase.from('collection_dispatches').select('id, etapa, canal, status, origem, contas_financeiras_id').in('id', dispatchIds) : Promise.resolve({ data: [] }),
      instanceIds.length ? supabase.from('whatsapp_instances').select('id, name, instance_name').in('id', instanceIds) : Promise.resolve({ data: [] }),
    ])
    if (e2) throw e2
    if (e3) throw e3

    const dispatchPorId = new Map((dispatches ?? []).map((d) => [d.id, d]))
    const instanciaPorId = new Map((instancias ?? []).map((i) => [i.id, i]))

    res.json((tentativas ?? []).map((t) => ({
      id: t.id,
      attempt_number: t.attempt_number,
      status: t.status,
      failure_kind: t.failure_kind,
      instancia: instanciaPorId.get(t.whatsapp_instance_id)?.name ?? null,
      dispatch: dispatchPorId.get(t.dispatch_id) ? {
        id: t.dispatch_id,
        etapa: dispatchPorId.get(t.dispatch_id).etapa,
        canal: dispatchPorId.get(t.dispatch_id).canal,
        status: dispatchPorId.get(t.dispatch_id).status,
        origem: dispatchPorId.get(t.dispatch_id).origem,
        // Só o técnico (uuid do título), nunca nome/telefone do cliente — mesma
        // regra de PII usada nos outros relatórios read-only do motor v2.
        contas_financeiras_id: dispatchPorId.get(t.dispatch_id).contas_financeiras_id,
      } : null,
      enviado_em: t.enviado_em,
      entregue_em: t.entregue_em,
      lido_em: t.lido_em,
      falhou_em: t.falhou_em,
      criado_em: t.criado_em,
    })))
  } catch (err) {
    res.status(500).json({ erro: err.message })
  }
})

export default router
