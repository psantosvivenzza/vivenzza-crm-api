import axios from 'axios'
import { supabase } from '../lib/supabase.js'

const EVOLUTION_URL = process.env.EVOLUTION_API_URL || 'https://evolution-api-production-6f0a.up.railway.app'
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY
const INSTANCE = process.env.EVOLUTION_INSTANCE || 'vivenzza'
const PETERSON_NUMERO = '555131372313'

const evolutionApi = axios.create({
  baseURL: EVOLUTION_URL,
  headers: { apikey: EVOLUTION_KEY },
  timeout: 15000,
})

async function enviarAlerta(texto) {
  try {
    await evolutionApi.post(`/message/sendText/${INSTANCE}`, {
      number: PETERSON_NUMERO,
      text: texto,
    })
    return true
  } catch {
    return false
  }
}

async function alertaRecente() {
  // Verifica se já enviamos alerta de "offline" nos últimos 60 min para não inundar
  const limite = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { data } = await supabase
    .from('evolution_health')
    .select('id, status, alerta_enviado')
    .gte('verificado_em', limite)
    .order('verificado_em', { ascending: false })
    .limit(10)

  // Se algum registro recente já tem alerta_enviado=true para status != open → não alertar de novo
  return (data || []).some((r) => r.alerta_enviado && r.status !== 'open')
}

export async function runEvolutionHealthCheck() {
  const inicio = Date.now()
  let status = 'error'
  let latencia = null
  let detalhes = {}
  let alertaEnviado = false

  try {
    const { data: instancias } = await evolutionApi.get('/instance/fetchInstances')
    latencia = Date.now() - inicio

    // Evolution API v2 retorna array. Cada item tem instance.instanceName e instance.connectionStatus
    const lista = Array.isArray(instancias) ? instancias : Object.values(instancias || {})
    const instancia = lista.find(
      (i) => (i.instance?.instanceName || i.instanceName) === INSTANCE
    )

    const connStatus = instancia?.instance?.connectionStatus
      || instancia?.instance?.status
      || instancia?.connectionStatus
      || instancia?.status
      || 'unknown'

    status = connStatus === 'open' ? 'open' : connStatus
    detalhes = { instanceName: instancia?.instance?.instanceName || INSTANCE, raw_status: connStatus }

  } catch (err) {
    latencia = Date.now() - inicio
    status = 'error'
    detalhes = { erro: err.message, code: err.code }
    console.error('[evolution-health] erro ao checar:', err.message)
  }

  // Insere registro de saúde
  const { data: registro, error: insertErr } = await supabase
    .from('evolution_health')
    .insert({ status, latencia_ms: latencia, detalhes, alerta_enviado: false })
    .select('id')
    .single()

  if (insertErr) {
    console.error('[evolution-health] erro ao inserir registro:', insertErr.message)
  }

  // Alerta se não estiver open
  if (status !== 'open') {
    const jaAlertou = await alertaRecente()
    if (!jaAlertou) {
      const emoji = status === 'error' ? '🔴' : '🟠'
      const msg = `${emoji} *WhatsApp CRM FORA*\n\nStatus: ${status}\nLatência: ${latencia}ms\nInstância: ${INSTANCE}\n\nVerifique em: ${EVOLUTION_URL}`
      alertaEnviado = await enviarAlerta(msg)

      if (registro?.id) {
        await supabase.from('evolution_health').update({ alerta_enviado: alertaEnviado }).eq('id', registro.id)
      }
    }
  }

  const resultado = { status, latencia_ms: latencia, alerta_enviado: alertaEnviado }
  console.log('[evolution-health]', resultado)
  return resultado
}
