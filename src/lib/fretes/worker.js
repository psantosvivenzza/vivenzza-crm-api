import { supabase } from '../supabase-admin.server.js'
import { FRETE_INSTANCE } from './domain.js'
export { FRETE_INSTANCE } from './domain.js'
import { enviarTexto, classifyEvolutionFailure } from '../collection/evolutionAdapter.js'
import { estaEmDoNotContact } from '../collection/doNotContactGuard.js'
import { verificarLimiteGlobalEnvio } from '../collection/globalSendLimit.js'
import { contarEnviosReaisHojePorInstancia, contarEnviosReaisDesdePorInstancia, registrarSucessoEnvio, registrarFalhaEnvio } from '../collection/whatsappInstances.js'
import { candidatosTelefone, telefonesEquivalentes } from '../telefone.js'

export async function checked(query) {
  const result = await query
  if (result.error) throw result.error
  return result.data
}
export async function runFreteQueue({ db = supabase, send = enviarTexto, now = new Date(), installed = process.env.FRETE_MODULO_INSTALADO === 'true', enabled = process.env.FRETE_ENVIO_ATIVO === 'true', assistantEnabled = process.env.FRETE_IA_ATIVA === 'true', dnc = estaEmDoNotContact, globalLimit = verificarLimiteGlobalEnvio, instanceCounts = contarEnviosReaisHojePorInstancia, instanceHourCounts = contarEnviosReaisDesdePorInstancia, recordSuccess = registrarSucessoEnvio, recordFailure = registrarFalhaEnvio } = {}) {
  if (!installed) return { status: 'nao_instalado' }
  const cutoff = new Date(new Date(now).getTime() - 120000).toISOString()
  // Crash/timeout reconciliation never puts a possibly delivered message back into fila.
  const interrompidos = await checked(db.from('frete_envios').update({ status: 'revisao', error_code: 'ENVIO_INTERROMPIDO' }).eq('status', 'enviando').lt('attempted_at', cutoff).select('consulta_id'))
  for (const envio of interrompidos ?? []) {
    await checked(db.from('frete_consultas').update({ ia_pausada: true }).eq('id', envio.consulta_id).neq('status', 'encerrada'))
    await checked(db.from('frete_consultas').update({ status: 'revisao' }).eq('id', envio.consulta_id).eq('completa', false).neq('status', 'encerrada'))
  }
  if (!enabled) return { status: 'desativado' }
  const rows = await checked(db.from('frete_envios').select('*').eq('status', 'fila').order('created_at').limit(1))
  if (!rows?.length) return { status: 'vazio' }
  let envio = rows[0]
  let reservadoParaEnvio = false
  let confirmado = false,estadoAlterado=false
  let instanciaId
  const finish = async (status, error_code) => {
    await checked(db.from('frete_envios').update({ status, error_code }).eq('id', envio.id))
    if (status === 'revisao' || status === 'bloqueado') await checked(db.from('frete_consultas').update({ status: 'revisao', ia_pausada: true }).eq('id', envio.consulta_id).in('status', ['fila', 'enviando', 'aguardando', 'falha', 'revisao']).eq('completa', false))
    return { status, error_code }
  }
  try {
    const consulta = await checked(db.from('frete_consultas').select('*').eq('id', envio.consulta_id).single())
    const cotacao = await checked(db.from('frete_cotacoes').select('*').eq('id', consulta.cotacao_id).single())
    const fornecedor = await checked(db.from('fornecedores').select('*').eq('id', consulta.fornecedor_id).single())
    if (envio.mensagem_id && !assistantEnabled) return finish('bloqueado', 'ASSISTENTE_DESATIVADO')
    if (envio.instance_name !== FRETE_INSTANCE || consulta.instance_name !== FRETE_INSTANCE || cotacao.status !== 'aberta' || consulta.status === 'encerrada' || consulta.ia_pausada || fornecedor.ativo !== true || fornecedor.participa_cotacao_frete !== true || fornecedor.cotacao_frete_consentimento !== true || !telefonesEquivalentes(envio.telefone, fornecedor.telefone_cotacao_frete) || !telefonesEquivalentes(envio.telefone, consulta.telefone)) return finish('bloqueado', 'CADASTRO_OU_COTACAO_BLOQUEADA')
    const instancia = await checked(db.from('whatsapp_instances').select('*').eq('instance_name', FRETE_INSTANCE).single())
    instanciaId = instancia.id
    // O healthcheck persiste o estado bruto da Evolution (open). Aceitar também
    // connected preserva compatibilidade com cadastros já normalizados.
    if (!instancia.enabled || !['open', 'connected'].includes(instancia.connection_status) || ['disabled', 'disconnected'].includes(instancia.health_status) || (instancia.cooldown_until && new Date(instancia.cooldown_until) > new Date(now))) return { status: 'aguardando_instancia' }
    for (const candidato of candidatosTelefone(envio.telefone)) {
      if ((await dnc(candidato)).blocked) return finish('bloqueado', 'DNC')
    }
    if (!(await globalLimit()).permitido) return { status: 'aguardando_limite' }
    const counts = await instanceCounts()
    if (instancia.daily_limit != null && (counts.get(instancia.id) ?? 0) >= instancia.daily_limit) return { status: 'aguardando_limite' }
    if (instancia.hourly_limit != null) {
      const inicioHora = new Date(now); inicioHora.setUTCMinutes(0, 0, 0)
      const countsHora = await instanceHourCounts(inicioHora.toISOString())
      if ((countsHora.get(instancia.id) ?? 0) >= instancia.hourly_limit) return { status: 'aguardando_limite' }
    }
    const claimed = await checked(db.rpc('frete_claim_envio', { p_envio_id: envio.id }))
    const reservado = Array.isArray(claimed) ? claimed[0] : claimed
    if (!reservado) return { status: 'ocupado' }
    envio = reservado
    reservadoParaEnvio = true
    const result = await send(instancia, envio.telefone, envio.texto)
    if (!result?.ok || !result.providerMessageId) return finish('revisao', 'RESULTADO_AMBIGUO')
    const atualizados=await checked(db.from('frete_envios').update({ status: 'enviado', provider_id: result.providerMessageId, error_code: null }).eq('id', envio.id).eq('status','enviando').select('id'))
    if(!atualizados?.length){
      await checked(db.from('frete_envios').update({provider_id:result.providerMessageId}).eq('id',envio.id))
      estadoAlterado=true
    }
    confirmado = true
    // Métricas não podem transformar sucesso confirmado em reenvio.
    try { await recordSuccess(instancia.id) } catch {}
    const saved = await db.from('frete_mensagens').insert({ cotacao_id: consulta.cotacao_id, consulta_id: consulta.id, direcao: 'saida', texto: envio.texto, evolution_id: result.providerMessageId })
    if (saved.error && saved.error.code !== '23505') throw saved.error
    if(!estadoAlterado)await checked(db.from('frete_consultas').update({ status: 'aguardando', updated_at: new Date(now).toISOString() }).eq('id', consulta.id).in('status', ['fila', 'enviando']).eq('ia_pausada', false))
    return estadoAlterado?{status:'revisao',error_code:'ESTADO_ALTERADO_APOS_ENVIO'}:{ status: 'enviado' }
  } catch (error) {
    if (confirmado) {
      try { await checked(db.from('frete_envios').update({ error_code: 'HISTORICO_PENDENTE' }).eq('id', envio.id)) } catch {}
      console.error('[fretes] envio confirmado; histórico pendente de conferência')
      return { status: 'enviado', error_code: 'HISTORICO_PENDENTE' }
    }
    if (!reservadoParaEnvio) return { status: 'aguardando_banco' }
    if (classifyEvolutionFailure(error).affectsInstanceHealth) { try { await recordFailure(instanciaId) } catch {} }
    return finish('revisao', error.numeroInvalido ? 'NUMERO_INVALIDO' : 'VERIFICAR_ENVIO_MANUALMENTE')
  }
}
