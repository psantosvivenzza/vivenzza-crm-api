import axios from 'axios'
import { supabase } from '../lib/supabase.js'

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
const INSTANCIAS_MONITORADAS = [
  INSTANCE,
  process.env.FINANCEIRO_WHATSAPP_INSTANCE || 'vivenzza-financeiro',
]

const NOME_AMIGAVEL = {
  vivenzza: 'WhatsApp Comercial',
  'vivenzza-financeiro': 'WhatsApp Financeiro (Cobrança)',
}

const PETERSON_NUMERO = '555131372313'

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 15000,
})

async function enviarAlerta(texto) {
  try {
    // Sempre manda pelo `INSTANCE` (comercial) — é a única que sabemos que
    // normalmente está de pé para avisar o Peterson, mesmo quando a
    // instância com problema é a outra (a financeira).
    await evolutionApi.post(`/message/sendText/${INSTANCE}`, {
      number: PETERSON_NUMERO,
      text: texto,
    })
    return true
  } catch {
    return false
  }
}

// Verifica se já enviamos alerta de "offline" para ESSA instância nos
// últimos 60 min, para não inundar o Peterson de mensagens repetidas.
async function alertaRecente(nomeInstancia) {
  const limite = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('evolution_health')
    .select('id, status, alerta_enviado, detalhes')
    .gte('verificado_em', limite)
    .order('verificado_em', { ascending: false })
    .limit(20)

  return (data || []).some(
    (r) => r.alerta_enviado && r.status !== 'open' && r.detalhes?.instanceName === nomeInstancia
  )
}

function statusDaInstancia(lista, nomeInstancia) {
  const instancia = lista.find(
    (i) => (i.name || i.instance?.instanceName || i.instanceName) === nomeInstancia
  )
  if (!instancia) return 'not_found'
  return instancia?.connectionStatus
    || instancia?.instance?.connectionStatus
    || instancia?.instance?.status
    || instancia?.status
    || 'unknown'
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
    const jaAlertou = await alertaRecente(nomeInstancia)
    if (!jaAlertou) {
      const nomeAmigavel = NOME_AMIGAVEL[nomeInstancia] || nomeInstancia
      const emoji = status === 'error' || status === 'not_found' ? '🔴' : '🟠'
      const msg = `${emoji} *${nomeAmigavel} FORA*\n\nStatus: ${status}\nLatência: ${latencia}ms\nInstância: ${nomeInstancia}\n\nVerifique em: ${EVOLUTION_URL}`
      alertaEnviado = await enviarAlerta(msg)

      if (registro?.id) {
        await supabase.from('evolution_health').update({ alerta_enviado: alertaEnviado }).eq('id', registro.id)
      }
    }
  }

  return { instancia: nomeInstancia, status, latencia_ms: latencia, alerta_enviado: alertaEnviado }
}

export async function runEvolutionHealthCheck() {
  const inicio = Date.now()
  let lista = []
  let latencia = null
  let erroGeral = null

  try {
    const { data: instancias } = await evolutionApi.get('/instance/fetchInstances')
    latencia = Date.now() - inicio
    // Evolution API v2 retorna array. Cada item tem instance.instanceName e instance.connectionStatus
    lista = Array.isArray(instancias) ? instancias : Object.values(instancias || {})
  } catch (err) {
    latencia = Date.now() - inicio
    erroGeral = err.message
    console.error('[evolution-health] erro ao checar:', err.message)
  }

  const resultados = []
  for (const nomeInstancia of INSTANCIAS_MONITORADAS) {
    if (erroGeral) {
      // A própria chamada à Evolution API falhou — não dá pra saber o status
      // de nenhuma instância, então registra 'error' para cada uma monitorada
      // (senão a financeira nunca teria um registro nesse cenário).
      resultados.push(await registrarEAlertar(nomeInstancia, 'error', latencia, { erro: erroGeral }))
      continue
    }

    const status = statusDaInstancia(lista, nomeInstancia)
    resultados.push(await registrarEAlertar(nomeInstancia, status, latencia, {
      raw_status: status,
    }))
  }

  console.log('[evolution-health]', resultados)
  return resultados
}
