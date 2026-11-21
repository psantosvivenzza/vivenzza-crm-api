// Read-only operational evidence. Enabled, reachable and successful are distinct.
import { SITE_CAMPAIGN } from './siteCampaignPolicy.js'
import { selectCommercialRecipient } from './sellerDailyBrief.js'
const snapshot = (result) => result?.status === 'fulfilled' && !result.value?.error ? result.value : null
const flag = (config, key) => typeof config?.[key] === 'boolean' ? config[key] : null
export function buildAutomationCapabilities({ config, evidence = {}, env = {}, now = new Date() }) {
  const card = (id, nome, ativo, estado, detalhe, extra = {}) => ({ id, nome, ativo, estado, detalhe, ...extra })
  const instances = snapshot(evidence.instances)?.data
  const site = snapshot(evidence.site)?.data
  const calls = snapshot(evidence.calls)?.data?.[0]
  const sync = snapshot(evidence.sync)
  const freight = snapshot(evidence.freight)?.data
  const aiReady = flag(config, 'financial_ai_enabled')
  const operational = evidence.operational || {}
  const model = evidence.model
  const commercial = evidence.commercial
  const laraReady = model?.pronto === true && commercial?.known === true && commercial?.connected === true
  const laraState = flag(config, 'sdr_ativo') === null ? 'indeterminado' : config.sdr_ativo !== true ? 'pausado'
    : model?.pronto === false ? 'bloqueado' : commercial?.known === true && commercial.connected !== true ? 'bloqueado'
    : laraReady ? 'habilitado' : 'indeterminado'
  const laraReason = model?.pronto === false ? model.motivo : commercial?.known === true && commercial.connected !== true
    ? 'O WhatsApp comercial está desconectado. Reconecte o canal para receber e responder clientes.'
    : !laraReady ? 'Modelo e conexão comercial ainda não foram confirmados.' : null
  const reactivation = snapshot(evidence.reactivation)?.data
  const billing = snapshot(evidence.billing)?.data?.[0]
  const notification = snapshot(evidence.notification)?.data?.[0]
  const externalCalls = flag(config, 'voice_external_enabled')
  const siteIdentity = !!env.SDR_SITE_INSTANCE?.trim() && site?.instance_name === env.SDR_SITE_INSTANCE.trim() && site.instance_name !== (env.EVOLUTION_INSTANCE || 'vivenzza')
  const siteEnabled = site ? site.enabled === true && env.SDR_SITE_ENABLED === 'true' : null
  const expired = now.getTime() > Date.parse(SITE_CAMPAIGN.expiresAt)
  const financial = Array.isArray(instances) ? instances.filter(x => x.role === 'financial' || /^vivenzza-financeiro(?:-reserva-0[12])?$/.test(x.instance_name)) : null
  const freshHealth = x => { const age = now.getTime() - Date.parse(x.last_connection_update); return Number.isFinite(age) && age >= 0 && age <= 30*60000 }
  const financialReady = financial?.some(x => x.enabled === true && x.health_status === 'connected' && freshHealth(x)
    && (x.instance_name === 'vivenzza-financeiro' || config?.whatsapp_failover === true))
  const billingFlag = flag(config, 'cobranca_whatsapp_ativa')
  const direction = snapshot(evidence.direction)?.data
  const directionConfigured = /^55\d{10,11}$/.test(env.DIRECTION_REPORT_NUMBER || '')
  const directionReady = direction?.connected === true && direction?.owner === 'fzap'
  const summaryEnabled = env.DIRECTION_DAILY_SUMMARY_ENABLED === 'true'
  const sellerSummaryEnabled = env.SELLER_DAILY_BRIEF_ENABLED === 'true'
  let commercialConfigured = false
  try { commercialConfigured = !!selectCommercialRecipient(env.LEADS_PARADOS_COMERCIAL_NUMBER, env.DIRECTION_REPORT_NUMBER) } catch {}
  return [
    card('lara', 'Lara — atendimento comercial', flag(config, 'sdr_ativo'), laraState, 'Lara atende o primeiro contato e qualifica a venda em qualquer horário. Pausa quando um humano assume a conversa; dúvidas sem resposta segura são encaminhadas à equipe.', { motivo_operacional: laraReason, ultima_atividade: evidence.sdr?.ultima_atividade ?? null, atendimentos_hoje: evidence.sdr?.leads_atendidos_hoje ?? null }),
    card('financeiro-ia', 'IA de atendimento financeiro', aiReady, aiReady === null ? 'nao_preparado' : !aiReady ? 'pausado' : operational['financeiro-ia']?.pode_habilitar ? 'habilitado' : 'bloqueado', 'Atendimento de texto por IA, das 9h às 17h em dias úteis. Até três respostas por contato em 24h; pagamentos informados, acordos, contestação e pedido de atendente vão para a equipe. A régua continua separada.', { ...operational['financeiro-ia'], motivo_operacional: model?.pronto === false ? model.motivo : operational['financeiro-ia']?.bloqueio_ativacao }),
    card('financeiro-regua', 'Cobrança automática financeira', billingFlag, billingFlag === null ? 'indeterminado' : !billingFlag ? 'pausado' : !sync ? 'indeterminado' : sync.allowed !== true ? 'bloqueado' : !financial || sync.reason === 'guard_desabilitado' ? 'indeterminado' : !financialReady ? 'bloqueado' : 'habilitado', !sync ? 'Não foi possível confirmar o frescor dos títulos e pagamentos.' : sync.allowed !== true || sync.reason === 'guard_desabilitado' ? 'Frescor financeiro não comprovado; consulte o controle de atualização.' : !financialReady ? 'Nenhum canal financeiro habilitado com saúde conectada confirmada.' : 'Régua habilitada; respeita horário, pagamentos, promessas, recusas e limites.', { ultima_execucao: billing?.data_envio ?? null, ultimo_resultado: billing?.status ?? null, sincronizacao: sync ? { permitido: sync.allowed === true, motivo: sync.reason, ultima: sync.last_sync_at } : null, canais: financial?.map(x => ({ nome: x.name, instancia: x.instance_name, habilitado: x.enabled === true, saude: x.health_status, ultima_sucesso: x.last_success_at })) ?? null, alternancia: flag(config, 'whatsapp_failover'), regra_alternancia: 'Somente falha técnica definitiva permite outra tentativa. Sem repetir por mensagem não lida, resultado incerto, recusa ou bloqueio do destinatário.' }),
    card('reativacao-site', 'Reativação do site', site ? site.enabled===true : null, siteEnabled === null ? 'indeterminado' : expired ? 'expirado' : !siteEnabled ? 'pausado' : !siteIdentity || site.ai_verified !== true || operational['reativacao-site']?.pode_habilitar !== true ? 'bloqueado' : 'habilitado', 'Campanha do site separada da reativação comercial. Retoma somente contatos pendentes elegíveis; resultados incertos e reservados não são reenviados.', { ultima_tentativa: site?.last_attempt_at ?? null, expira_em: SITE_CAMPAIGN.expiresAt,...operational['reativacao-site'] }),
    card('reativacao-comercial', 'Reativação de leads comerciais', flag(config, 'reativacao_ativa'), flag(config, 'reativacao_ativa') === null ? 'indeterminado' : !config.reativacao_ativa ? 'pausado' : commercial?.known !== true ? 'indeterminado' : commercial.connected !== true ? 'bloqueado' : 'habilitado', 'Follow-up de leads do CRM, separado da campanha do site. Configuração habilitada não comprova envio.', { motivo_operacional: config?.reativacao_ativa === true && commercial?.known === true && commercial.connected !== true ? 'O WhatsApp comercial está desconectado. Reconecte o canal antes da próxima rodada.' : null, envios_hoje: reactivation?.enviados ?? null, respostas_hoje: reactivation?.responderam ?? null, encaminhados_hoje: reactivation?.passados_vendedor ?? null }),
    card('ligacoes', 'Ligações de cobrança', externalCalls, externalCalls === null ? 'indeterminado' : !externalCalls ? 'pausado' : operational.ligacoes?.pode_habilitar ? 'habilitado' : 'bloqueado', 'Fila de ligações por IA no executor local. Pausar impede novas discagens; chamadas já em andamento continuam. Prontidão e áudio são verificados separadamente da conexão WhatsApp.', { ultima_execucao: calls?.started_at ?? null, ultimo_resultado: calls?.status ?? null, consulta_disponivel: snapshot(evidence.calls) !== null,...operational.ligacoes }),
    card('frete', 'Assistente de cotação de frete', env.FRETE_ENVIO_ATIVO === 'true', !freight ? 'indeterminado' : freight.ativo !== true || env.FRETE_MODULO_INSTALADO !== 'true' || env.FRETE_ENVIO_ATIVO !== 'true' ? 'pausado' : env.FRETE_IA_ATIVA === 'true' && model?.pronto !== true ? 'bloqueado' : 'habilitado', 'Consulta e coleta de propostas. Não contrata transporte nem retoma cotações encerradas.', { motivo_operacional: env.FRETE_IA_ATIVA === 'true' && model?.pronto !== true ? model?.motivo || 'A IA da cotação ainda não foi confirmada.' : null, controle_orcamento: freight?.ativo ?? null, ia_habilitada: env.FRETE_IA_ATIVA === 'true', modulo_instalado: env.FRETE_MODULO_INSTALADO === 'true' }),
    card('direcao', 'Notificações para o Diego / direção', directionConfigured, !directionConfigured ? 'nao_preparado' : !direction ? 'indeterminado' : directionReady ? 'habilitado' : 'bloqueado', 'Canal exclusivo de notificações. Alertas existentes conservam seus horários; conexão não comprova entrega de cada mensagem.', { ultimo_aviso: notification?.updated_at ?? null }),
    card('resumo-direcao', 'Resumo comercial e financeiro — 18h', summaryEnabled, !summaryEnabled ? 'pausado' : !direction ? 'indeterminado' : directionReady ? 'habilitado' : 'bloqueado', 'Somente o novo resumo diário às 18h de Brasília. Vendas e previsão dependem de fontes atualizadas; recebimentos e quitações ainda aguardam cobertura comprovada.'),
    card('vendedores-resumo', 'Resumo e motivação da equipe — 9h05', sellerSummaryEnabled, !sellerSummaryEnabled ? 'pausado' : !commercialConfigured ? 'bloqueado' : !direction ? 'indeterminado' : directionReady ? 'habilitado' : 'bloqueado', 'Uma mensagem diária no Comercial, com indicadores consolidados da equipe e orientação prática de vendas. Independente da reativação de clientes e da geração por IA. Configuração ligada não comprova entrega; exige destinos confirmados.'),
    card('aprendizado', 'Aprendizado comercial e financeiro', null, 'nao_preparado', 'Histórico de conversa não equivale a aprendizado contínuo. Conhecimento aprovado, versões e métricas precisam ser rastreáveis; conversas não podem alterar regras financeiras ou de segurança.'),
  ]
}

export async function readAutomationEvidence({ db, syncGuard, directionCheck, timeoutMs = 10000 }) {
  const bounded = query => query.abortSignal(AbortSignal.timeout(timeoutMs))
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'America/Sao_Paulo'}).format(new Date())
  const tasks = {
    reactivation: () => bounded(db.from('reativacao_metricas').select('enviados,responderam,passados_vendedor').eq('data',today).maybeSingle()),
    billing: () => bounded(db.from('cobrancas_whatsapp').select('data_envio,status').eq('origem','cron').in('status',['enviada','respondida','paga']).order('data_envio',{ascending:false,nullsFirst:false}).limit(1)),
    notification: () => bounded(db.from('direction_notification_deliveries').select('updated_at').eq('status','sent').order('updated_at',{ascending:false}).limit(1)),
    instances: () => bounded(db.from('whatsapp_instances').select('name,instance_name,role,enabled,health_status,last_success_at,last_connection_update,priority').order('priority', { ascending: true })),
    site: () => bounded(db.from('site_campaign_config').select('enabled,ai_verified,instance_name,expires_at,last_attempt_at').eq('id', 'volte10_20261023').maybeSingle()),
    calls: () => bounded(db.from('voice_calls').select('started_at,status').order('started_at', { ascending: false, nullsFirst: false }).limit(1)),
    freight: () => bounded(db.from('frete_orcamento_controle').select('ativo').eq('id', 1).maybeSingle()),
    sync: async () => {
      let timer
      try { return await Promise.race([Promise.resolve().then(syncGuard), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SYNC_STATUS_TIMEOUT')), timeoutMs) })]) }
      finally { clearTimeout(timer) }
    },
  }
  if (directionCheck) tasks.direction = async () => {
    let timer
    try { return {data:await Promise.race([Promise.resolve().then(directionCheck),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DIRECTION_STATUS_TIMEOUT')),timeoutMs)})])} }
    finally { clearTimeout(timer) }
  }
  const keys = Object.keys(tasks)
  const values = await Promise.allSettled(keys.map(key => Promise.resolve().then(tasks[key])))
  return Object.fromEntries(keys.map((key, i) => [key, values[i]]))
}
