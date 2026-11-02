import { createLeadStageAdvisor, PIPELINE_STAGE_PROMPT, parseStageAdvice } from './leadStageAdvisor.js'
import { supabase } from './supabase-admin.server.js'
import { obterConfigCobranca } from './collection/featureFlags.js'
const checked = async query => { const result = await query.abortSignal(AbortSignal.timeout(10000)); if (result.error) throw Error('STAGE_EVIDENCE_UNAVAILABLE'); return result.data }
export const observeCommercialStage = createLeadStageAdvisor({
 enabled: async () => {
  const config = await obterConfigCobranca()
  return config.lara_pipeline_automatico === true && config.alerta_sem_resposta_por_conversa === true
 },
 onError: () => console.error('[pipeline-ai] deferred_analysis_failed'),
 load: async leadId => {
  const [lead, rows] = await Promise.all([
   checked(supabase.from('leads').select('id,etapa,ativo,whatsapp_opt_out,updated_at,responsavel_id').eq('id', leadId).maybeSingle()),
   checked(supabase.from('whatsapp_mensagens').select('id,evolution_id,direcao,mensagem,created_at').eq('lead_id', leadId).not('evolution_id','is',null).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(20)),
  ])
  return { lead, messages: (rows || []).reverse() }
 },
 classify: async context => {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const { default: Anthropic } = await import('@anthropic-ai/sdk')
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 12000, maxRetries: 0 })
  const response = await client.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 512, system: PIPELINE_STAGE_PROMPT, messages: [{role:'user',content:JSON.stringify(context)}] })
  return parseStageAdvice(response.content?.find(c=>c.type==='text')?.text)
 },
 apply: async value => checked(supabase.rpc('apply_lead_stage_advice', { p_lead_id:value.leadId,p_expected_stage:value.expectedStage,p_expected_version:value.expectedVersion,p_next_stage:value.etapa,p_message_id:value.messageId,p_evidence:value.evidence })),
})
