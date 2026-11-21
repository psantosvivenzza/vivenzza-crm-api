import {withDiagnosticDeadline} from './automationDiagnostics.js'
export async function operationalReadiness({db,config,env,evidence,modelReady,sessionReady,timeoutMs=6000}) {
 const value=key=>evidence?.[key]?.status==='fulfilled'&&!evidence[key].value?.error?evidence[key].value:null
 const sync=value('sync'),site=value('site')?.data,instances=value('instances')?.data
 const siteConfigured=!!site&&env.SDR_SITE_ENABLED==='true'&&site.ai_verified===true&&site.instance_name===env.SDR_SITE_INSTANCE&&site.instance_name!==(env.EVOLUTION_INSTANCE||'vivenzza')&&Date.parse(site.expires_at)>Date.now()&&modelReady===true
 const [storage,financialHealth,siteHealth,voiceHealth]=await Promise.allSettled([
  withDiagnosticDeadline(()=>db.from('financial_ai_contacts').select('id',{head:true,count:'exact'}).abortSignal(AbortSignal.timeout(timeoutMs)),timeoutMs),
  withDiagnosticDeadline(async()=>{for(const c of Array.isArray(instances)?instances:[]){if(!['principal','reserva'].includes(c.role)||c.enabled!==true)continue;try{if(await sessionReady(c.instance_name)===true)return true}catch{}}return false},timeoutMs),
  withDiagnosticDeadline(async()=>siteConfigured&&await sessionReady(site.instance_name)===true,timeoutMs),
  withDiagnosticDeadline(()=>db.rpc('voice_operational_ready').abortSignal(AbortSignal.timeout(timeoutMs)),timeoutMs),
 ])
 const storageKnown=storage.status==='fulfilled'&&!storage.value.error
 const financialChannel=financialHealth.status==='fulfilled'&&financialHealth.value===true
 const financialReady=storageKnown&&typeof config.financial_ai_enabled==='boolean'&&config.cobranca_whatsapp_ativa===true&&env.FRETE_MODULO_INSTALADO==='true'&&modelReady===true&&value('freight')?.data?.ativo===true&&sync?.allowed===true&&sync.reason!=='guard_desabilitado'&&financialChannel
 const siteReady=siteHealth.status==='fulfilled'&&siteHealth.value===true
 const voiceReady=voiceHealth.status==='fulfilled'&&!voiceHealth.value?.error&&voiceHealth.value?.data===true
 return {
  'financeiro-ia':{controle_disponivel:typeof config.financial_ai_enabled==='boolean',pode_habilitar:financialReady,bloqueio_ativacao:financialReady?null:'Verifique fonte financeira atualizada, régua, IA, orçamento compartilhado e canal financeiro conectado.'},
  'ligacoes':{controle_disponivel:typeof config.voice_external_enabled==='boolean',pode_habilitar:voiceReady,bloqueio_ativacao:voiceReady?null:'Prontidão da telefonia, agenda e áudio ainda não confirmada pelo executor local. Desligar permanece disponível.'},
  'reativacao-site':{controle_disponivel:!!site,pode_habilitar:siteReady,bloqueio_ativacao:siteReady?null:'Verifique canal do site, IA, configuração da campanha e validade da oferta.'},
 }
}
