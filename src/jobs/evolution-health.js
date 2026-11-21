import { createWhatsappProviderClient } from '../lib/whatsappProviderClient.js'
import { supabase } from '../lib/supabase-admin.server.js'
import { atualizarStatusConexao } from '../lib/collection/whatsappInstances.js'
import { enviarAlertaWhatsapp } from '../lib/whatsappAlert.js'

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY

// Instância usada para AVISAR o Peterson (sempre a comercial — é a que ele já
// tem no celular). Mesma variável usada antes desta mudança, mantida por
// compatibilidade.
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'

// Instâncias efetivamente MONITORADAS nesta checagem. Antes só existia
// `vivenzza` (comercial) — depois da suspensão da instância financeira em
// 2026-07-30 (rajada de ~50 msgs sem intervalo, ver correção em
// jobs/cobranca-whatsapp.js), ninguém tinha alerta automático de que ela
// tinha caído; só se percebeu porque não saiu nenhum disparo da régua naquele
// dia. Agora as duas instâncias entram na mesma checagem de 15 em 15 min.
// Nome da env reaproveitado de evolutionFinanceiro.js para não duplicar
// configuração.
//
// FASE C.3C (homologação, 2026-08-12) — inclui a reserva financeira exclusiva
// (vivenzza-financeiro-reserva-01) no mesmo ciclo de 15min, sem cron novo e
// sem mudar a lógica de alerta/circuit breaker. Ainda dormente: cadastrada em
// whatsapp_instances como role=reserve, só passa a ser usada de verdade
// quando whatsapp_failover=true (continua false nesta fase).
const INSTANCIAS_MONITORADAS = [
  INSTANCE,
  process.env.FINANCEIRO_WHATSAPP_INSTANCE || 'vivenzza-financeiro',
  process.env.FINANCEIRO_RESERVA_WHATSAPP_INSTANCE || 'vivenzza-financeiro-reserva-01',
]

const NOME_AMIGAVEL = {
  vivenzza: 'WhatsApp Comercial',
  'vivenzza-financeiro': 'WhatsApp Financeiro (Cobrança)',
  'vivenzza-financeiro-reserva-01': 'WhatsApp Financeiro Reserva 01',
}

const evolutionApi = createWhatsappProviderClient({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 15000,
})

// CORRIGIDO 2026-08-03: antes disso, o alerta de "instância X caiu" era
// sempre enviado ATRAVÉS da própria instância comercial (`INSTANCE`) — o que
// falha silenciosamente exatamente quando `INSTANCE` é a que caiu (foi o que
// aconteceu no incidente de hoje: vivenzza ficou 2h+ fora do ar e nenhum
// alerta saiu, porque o "mensageiro" era o próprio que tinha morrido).
// Agora tenta mandar por qualquer instância monitorada que NÃO seja a que
// está com problema, e só tenta a própria instância com problema como último
// recurso (caso já tenha voltado entre a checagem e o envio).
async function enviarAlerta(texto, instanciaComProblema) {
  try { await enviarAlertaWhatsapp(texto,{key:'health:'+instanciaComProblema+':'+Math.floor(Date.now()/3600000)}); return true }
  catch { return false }
}

// Verifica se já enviamos alerta de "offline" para ESSA instância nos
// últimos 60 min, para não inundar o Peterson de mensagens repetidas.
async function alertaRecente(nomeInstancia, status) {
  const limite = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('evolution_health')
    .select('id, status, alerta_enviado, detalhes')
    .gte('verificado_em', limite)
    .order('verificado_em', { ascending: false })
    .limit(20)

  return (data || []).some(
    (r) => r.alerta_enviado && r.status !== 'open' && r.detalhes?.instanceName === nomeInstancia &&
      ['error', 'unknown'].includes(r.status) === ['error', 'unknown'].includes(status)
  )
}

async function registrarEAlertar(nomeInstancia, status, latencia, detalhesExtra = {}) {
  const detalhes = { instanceName: nomeInstancia, ...detalhesExtra }

  const { data: registro, error: insertErr } = await supabase
    .from('evolution_health')
    .insert({ status, latencia_ms: latencia, detalhes, alerta_enviado: false })
    .select('id')
    .single()

  if (insertErr) {
    console.error(`[evolution-health] erro ao inserir registro (${nomeInstancia}):`, insertErr.message)
  }

  let alertaEnviado = false
  if (status !== 'open') {
    const jaAlertou = await alertaRecente(nomeInstancia, status)
    if (!jaAlertou) {
      const nomeAmigavel = NOME_AMIGAVEL[nomeInstancia] || nomeInstancia
      const emoji = status === 'error' || status === 'not_found' ? '🔴' : '🟠'
      const consultaInconclusiva = status === 'error' || status === 'unknown'
      const titulo = consultaInconclusiva ? 'CONEXÃO NÃO CONFIRMADA' : 'FORA'
      const explicacao = consultaInconclusiva ? '\nA consulta não conseguiu confirmar o estado da sessão.' : ''
      const msg = `${consultaInconclusiva ? '🟠' : emoji} *${nomeAmigavel} ${titulo}*\n\nStatus: ${status}\nLatência: ${latencia}ms\nInstância: ${nomeInstancia}${explicacao}\n\nVerifique em: Conexões WhatsApp no CRM`
      alertaEnviado = await enviarAlerta(msg, nomeInstancia)

      if (registro?.id) {
        await supabase.from('evolution_health').update({ alerta_enviado: alertaEnviado }).eq('id', registro.id)
      }
    }
  }

  return { instancia: nomeInstancia, status, latencia_ms: latencia, alerta_enviado: alertaEnviado }
}

export async function runEvolutionHealthCheck({ client = evolutionApi, instances = INSTANCIAS_MONITORADAS, record = registrarEAlertar, update = atualizarStatusConexao } = {}) {
  const readings = new Array(instances.length), resultados = []
  async function check(nomeInstancia) {
    const inicio = Date.now()
    let status
    try {
      // Resolve this instance's owner independently. An unavailable Evolution
      // inventory must not make an authoritative FZAP session appear offline.
      const { data } = await client.get(`/instance/connectionState/${encodeURIComponent(nomeInstancia)}`)
      status = data?.instance?.state ?? data?.state ?? 'unknown'
    } catch (error) {
      if (error?.response?.status === 404 && !String(error?.code || '').startsWith('FZAP_')) status = 'not_found'
      else {
        return { status: 'error', latencia: Date.now() - inicio, erro: error.message }
      }
    }
    return { status, latencia: Date.now() - inicio }
  }
  // Two independent checks at a time; an unavailable legacy instance cannot
  // serially delay every other connection by its full HTTP timeout.
  let next = 0
  await Promise.all(Array.from({ length: Math.min(2, instances.length) }, async () => {
    while (next < instances.length) {
      const index = next++
      readings[index] = await check(instances[index])
    }
  }))
  // Preserve sequential recording/alerts; only read-only provider checks run
  // concurrently, without creating a new burst of outbound notifications.
  for (let index = 0; index < instances.length; index++) {
    const nomeInstancia = instances[index], reading = readings[index]
    resultados.push(await record(nomeInstancia, reading.status, reading.latencia,
      reading.erro ? { erro: reading.erro } : { raw_status: reading.status }))
    if (reading.status === 'error' || reading.status === 'unknown') continue
    // UPDATE by existing instance_name, never creates a commercial reserve.
    try { await update(nomeInstancia, reading.status) } catch { /* preserve legacy no-op for unavailable table */ }
  }

  console.log('[evolution-health]', resultados)
  return resultados
}
