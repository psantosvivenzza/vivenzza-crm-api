// Disparo cadenciado do número da direção (instância vivenzza-notificacoes-direcao).
// Autorizado pelo dono em 21/11/2026: leads em proposta/negociação que não fecharam,
// 20/dia, 2 a 4 min entre mensagens, só em horário comercial.
// Segurança: nasce DESLIGADO (disparo_direcao_config.ativo=false); pausa sozinho após
// 3 falhas seguidas; envio de resultado incerto NUNCA é repetido; para se o lead
// respondeu, pediu para parar ou saiu do funil; usa as MESMAS checagens de conexão
// e posse do notificador da direção (directionNotifications.js).
import { supabase } from '../lib/supabase-admin.server.js'
import { readFzapConfig } from '../lib/fzapConnections.js'
import { createWhatsappProviderClient, whatsappTransportFor } from '../lib/whatsappProviderClient.js'

const INSTANCIA = 'vivenzza-notificacoes-direcao'
const MAX_FALHAS = 3
const TIMEOUT = 10000

// Seg–sex, 09:00–17:30 (America/Sao_Paulo).
export function dentroDaJanela(data = new Date()) {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(data)
  const get = (t) => partes.find((p) => p.type === t)?.value ?? ''
  const util = ['segunda', 'terça', 'quarta', 'quinta', 'sexta'].some((d) => get('weekday').includes(d))
  const min = Number(get('hour')) * 60 + Number(get('minute'))
  return util && min >= 9 * 60 && min <= 17 * 60 + 30
}

export function proximoIntervaloMs(minS, maxS, rand = Math.random) {
  const lo = Math.max(30, Number(minS) || 120)
  const hi = Math.max(lo, Number(maxS) || 240)
  return Math.round((lo + rand() * (hi - lo)) * 1000)
}

export function inicioDoDiaBRT(data = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(data)
  return new Date(`${ymd}T00:00:00-03:00`)
}

async function resolverCanal(env = process.env) {
  const config = readFzapConfig(env)
  const connection = config?.connections.find(
    (c) => c.id === 'direcao-notificacoes' && c.instanceName === INSTANCIA && c.finalidade === 'notificacoes')
  if (!connection || (await whatsappTransportFor(connection.instanceName, { env })) !== 'fzap') throw new Error('CANAL_NAO_PRONTO')
  const client = createWhatsappProviderClient({}, { env })
  const status = await client.get('/instance/connectionState/' + encodeURIComponent(INSTANCIA))
  if (status?.data?.instance?.state !== 'open') throw new Error('CANAL_DESCONECTADO')
  return client
}

async function pausar(motivo) {
  await supabase.from('disparo_direcao_config')
    .update({ ativo: false, motivo_pausa: motivo, atualizado_em: new Date().toISOString() }).eq('id', 1)
  console.error(`[disparo-direcao] PAUSADO: ${motivo}`)
}

export async function runDisparoDirecao({ agora = new Date() } = {}) {
  const sig = () => AbortSignal.timeout(TIMEOUT)
  const { data: cfg } = await supabase.from('disparo_direcao_config').select('*').eq('id', 1).abortSignal(sig()).maybeSingle()
  if (!cfg?.ativo) return { status: 'desligado' }
  if (!dentroDaJanela(agora)) return { status: 'fora_da_janela' }
  if (cfg.proximo_envio_apos && new Date(cfg.proximo_envio_apos) > agora) return { status: 'aguardando_intervalo' }

  const { count: enviadosHoje } = await supabase.from('disparo_direcao_fila')
    .select('id', { count: 'exact', head: true }).eq('status', 'enviado')
    .gte('enviado_em', inicioDoDiaBRT(agora).toISOString()).abortSignal(sig())
  if ((enviadosHoje ?? 0) >= cfg.limite_diario) return { status: 'limite_diario' }

  const { data: proximo } = await supabase.from('disparo_direcao_fila').select('*')
    .eq('status', 'pendente').order('ordem').limit(1).abortSignal(sig()).maybeSingle()
  if (!proximo) { await pausar('fila_concluida'); return { status: 'fila_vazia' } }

  // Reserva atômica: só um processo consegue passar de 'pendente' para 'enviando'.
  const { data: reservado } = await supabase.from('disparo_direcao_fila')
    .update({ status: 'enviando' }).eq('id', proximo.id).eq('status', 'pendente').select('id').abortSignal(sig())
  if (!reservado?.length) return { status: 'reserva_perdida' }

  const pular = async (motivo) => {
    await supabase.from('disparo_direcao_fila').update({ status: 'pulado', erro: motivo }).eq('id', proximo.id)
    return { status: 'pulado', motivo }
  }

  // Revalida o lead no momento do envio.
  const { data: lead } = await supabase.from('leads')
    .select('id,etapa,ativo,whatsapp_opt_out,ultima_mensagem_em').eq('id', proximo.lead_id).maybeSingle()
  if (!lead || !['proposta', 'negociacao'].includes(lead.etapa)) return pular('saiu_do_funil')
  if (lead.ativo === false || lead.whatsapp_opt_out) return pular('opt_out_ou_inativo')
  if (lead.ultima_mensagem_em && new Date(lead.ultima_mensagem_em) > new Date(Date.now() - 3 * 864e5)) return pular('conversa_recente')

  let client
  try {
    client = await resolverCanal()
  } catch (err) {
    await supabase.from('disparo_direcao_fila').update({ status: 'pendente' }).eq('id', proximo.id)
    await pausar(`canal_indisponivel:${err.message}`)
    return { status: 'canal_indisponivel' }
  }

  try {
    const r = await client.post('/message/sendText/' + encodeURIComponent(INSTANCIA), { number: proximo.telefone, text: proximo.mensagem })
    const id = r?.data?.key?.id
    if (!id) throw new Error('INCERTO')
    await supabase.from('disparo_direcao_fila')
      .update({ status: 'enviado', provider_message_id: id, enviado_em: new Date().toISOString() }).eq('id', proximo.id)
    await supabase.from('whatsapp_mensagens').insert({
      lead_id: proximo.lead_id, telefone: proximo.telefone, mensagem: proximo.mensagem,
      direcao: 'saida', status: 'enviado', evolution_id: id, instance_name: INSTANCIA,
    })
    await supabase.from('disparo_direcao_config').update({
      falhas_consecutivas: 0,
      proximo_envio_apos: new Date(Date.now() + proximoIntervaloMs(cfg.intervalo_min_s, cfg.intervalo_max_s)).toISOString(),
      atualizado_em: new Date().toISOString(),
    }).eq('id', 1)
    console.log(`[disparo-direcao] enviado ordem=${proximo.ordem} hoje=${(enviadosHoje ?? 0) + 1}/${cfg.limite_diario}`)
    return { status: 'enviado' }
  } catch (err) {
    // Resultado incerto: marca como falhou e NÃO repete (pode ter saído).
    await supabase.from('disparo_direcao_fila').update({ status: 'falhou', erro: String(err?.code || err?.message || 'erro').slice(0, 120) }).eq('id', proximo.id)
    const falhas = (cfg.falhas_consecutivas ?? 0) + 1
    await supabase.from('disparo_direcao_config').update({
      falhas_consecutivas: falhas,
      proximo_envio_apos: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }).eq('id', 1)
    if (falhas >= MAX_FALHAS) await pausar(`${MAX_FALHAS}_falhas_seguidas`)
    console.error(`[disparo-direcao] falha ordem=${proximo.ordem} falhas=${falhas}`)
    return { status: 'falhou' }
  }
}
