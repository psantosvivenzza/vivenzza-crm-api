// Envio manual restrito à lista aprovada. Não ativa cron/global/voz.
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {createHash} from 'node:crypto'
import { entriesFromPdf, crmClient, sourceClient, sourceRows, loadAccounts, reconcile, reportPath } from './audit-approved-portfolio.mjs'
import { CAMPAIGN, renderApprovedMessage, phoneKey } from '../src/lib/collection/approvedPortfolio.js'

if(process.argv.length!==3 || process.argv[2]!=='--send-approved-20261019') throw Error('confirmacao_explicita_obrigatoria')
if(process.env.LOCAL_PG_URL || process.env.NODE_ENV==='test')throw Error('ambiente_recusado')
const root=path.dirname(reportPath), lock=path.join(root,`${CAMPAIGN}.lock`)
const journal=path.join(root,`${CAMPAIGN}-private-dispatch.jsonl`)
const audit=JSON.parse(fs.readFileSync(reportPath,'utf8'))
const age=Date.now()-Date.parse(audit.at)
if(audit.campaign!==CAMPAIGN || !Number.isFinite(age)||age<0||age>30*60000||audit.today!==new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'}))throw Error('auditoria_expirada')
const entries=entriesFromPdf()
const correctionFile=path.join(root,`${CAMPAIGN}-private-recipient-correction.json`)
const correction=fs.existsSync(correctionFile)?JSON.parse(fs.readFileSync(correctionFile,'utf8')):null
const crm=crmClient()
const {data:config,error:configError}=await crm.from('automacoes_config').select('multi_whatsapp,cobranca_whatsapp_ativa,whatsapp_failover,global_daily_limit,global_hourly_limit').eq('id',1).single()
if(configError||config.multi_whatsapp!==true||config.cobranca_whatsapp_ativa!==false||config.whatsapp_failover!==false||!Number.isSafeInteger(config.global_daily_limit)||config.global_daily_limit<1||config.global_daily_limit>50||!Number.isSafeInteger(config.global_hourly_limit)||config.global_hourly_limit<1||config.global_hourly_limit>10)throw Error('config_lote_insegura')
const fd=fs.openSync(lock,'wx') // nunca remove lock de outro processo
const started=new Date().toISOString()
let source
const record=r=>{fs.appendFileSync(journal,JSON.stringify({at:new Date().toISOString(),campaign:CAMPAIGN,...r})+'\n');console.log(JSON.stringify({code:r.code,status:r.status,reason:r.reason,dispatchId:r.dispatchId}))}
try {
 source=await sourceClient()
 const {enviarCobrancaComRoteamento}=await import('../src/lib/collection/collectionRouting.js')
 const {verificarFrescorSync}=await import('../src/lib/collection/financialSyncGuard.js')
 const {verificarLimiteGlobalEnvio}=await import('../src/lib/collection/globalSendLimit.js')
 const {estaEmDoNotContact}=await import('../src/lib/collection/doNotContactGuard.js')
 const {telefonesEquivalentes,candidatosTelefone}=await import('../src/lib/telefone.js')
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'})
 const since=`${today}T03:00:00.000Z`
 const value=async query=>{const r=await query;if(r.error)throw Error('consulta_protecao_falhou');return r.data||[]}
 const pages=async build=>{const rows=[];for(let n=0;n<10000;n+=1000){const part=await value(build().order('id').range(n,n+999));rows.push(...part);if(part.length<1000)return rows}throw Error('historico_excede_limite_seguro')}
 const allAccounts=await loadAccounts(crm,entries.map(e=>e.code))
 // Qualquer compartilhamento de telefone entre clientes exige revisão humana.
 const owners=new Map()
 for(const a of allAccounts){try{const p=phoneKey(a.telefone_cobranca);if(!owners.has(p))owners.set(p,new Set());owners.get(p).add(a.codigo_cliente)}catch{}}
 const candidates=audit.plans.filter(p=>p.status==='ready').sort((a,b)=>Number(b.code===correction?.code)-Number(a.code===correction?.code)||b.totalCents-a.totalCents||a.code.localeCompare(b.code))
 let attempts=0
 for(const candidate of candidates){
  if(attempts>=10)break
  const entry=entries.find(e=>e.code===candidate.code)
  const windowOk=()=>{const now=new Date();const hour=Number(now.toLocaleString('en-US',{timeZone:'America/Sao_Paulo',hour:'2-digit',hourCycle:'h23'}));return now.getUTCDay()>=1&&now.getUTCDay()<=5&&hour>=9&&hour<17}
  if(!windowOk()){record({code:entry.code,status:'paused',reason:'fora_janela'});break}
  if([...owners].some(([phone,codes])=>telefonesEquivalentes(phone,candidate.phone)&&(codes.size>1||!codes.has(candidate.code)))){record({code:entry.code,status:'blocked',reason:'telefone_compartilhado'});continue}
  const revalidate=async()=>{
   if(!windowOk())return {allowed:false,reason:'fora_janela'}
   const sync=await verificarFrescorSync({ignorarCache:true});if(!sync.allowed)return {allowed:false,reason:sync.reason}
   const accounts=await loadAccounts(crm,[entry.code])
   const raw=await sourceRows(source,[entry.code],today)
   const plan=reconcile(entry,accounts,raw,today)
   if(plan.status!=='ready')return {allowed:false,reason:plan.reason}
   if(plan.phone!==candidate.phone||plan.totalCents!==candidate.totalCents||JSON.stringify(plan.accountIds)!==JSON.stringify(candidate.accountIds))return {allowed:false,reason:'saldo_ou_cadastro_alterado'}
   const ids=accounts.map(a=>a.id)
   const promises=await value(crm.from('collection_promises').select('id').in('contas_financeiras_id',ids).eq('status','ativa').limit(1))
   if(promises.length)return {allowed:false,reason:'promessa_ativa_cliente'}
   const dnc=await estaEmDoNotContact(candidate.phone);if(dnc.blocked)return {allowed:false,reason:dnc.reason}
   const limit=await verificarLimiteGlobalEnvio();if(!limit.permitido)return {allowed:false,reason:limit.motivo}
   const phoneVariants=candidatosTelefone(candidate.phone)
   const responseSince=new Date(Date.now()-30*86400000).toISOString()
   const messages=await pages(()=>crm.from('whatsapp_mensagens').select('id,telefone,instance_name').eq('direcao','entrada').gte('created_at',responseSince).in('telefone',phoneVariants).in('instance_name',['vivenzza-financeiro','vivenzza-financeiro-reserva-01','vivenzza-financeiro-reserva-02']))
   if(messages.some(m=>telefonesEquivalentes(m.telefone,candidate.phone)))return {allowed:false,reason:'resposta_recente_atendimento_humano'}
   const history=await pages(()=>crm.from('collection_dispatches').select('id,cliente_telefone').gte('criado_em',since).in('status',['sending','sent','delivered','read']))
   if(history.some(m=>m.id!==currentDispatchId&&telefonesEquivalentes(m.cliente_telefone,candidate.phone)))return {allowed:false,reason:'ja_contatado_hoje'}
   const legacy=await pages(()=>crm.from('cobrancas_whatsapp').select('id,cliente_telefone').gte('data_envio',since))
   if(legacy.some(m=>telefonesEquivalentes(m.cliente_telefone,candidate.phone)))return {allowed:false,reason:'ja_contatado_hoje'}
   return {allowed:true,plan}
  }
  let currentDispatchId=null
  const check=await revalidate()
  if(!check.allowed){record({code:entry.code,status:'blocked',reason:check.reason});if(String(check.reason).startsWith('limite_global'))break;continue}
  // Reserva global de uma primeira abordagem por cliente/campanha; resultado
  // incerto não é reenviado automaticamente nem depois de restart/dia seguinte.
  const message=renderApprovedMessage(check.plan)
  const corrected=correction?.code==='002009'&&entry.code===correction.code&&candidate.phone===correction.phone&&correction.sourceVerified===true&&correction.crmVerified===true&&Number.isFinite(Date.parse(correction.verifiedAt))&&Date.now()-Date.parse(correction.verifiedAt)>=0&&Date.now()-Date.parse(correction.verifiedAt)<86400000
  const claimKey=`${CAMPAIGN}:${entry.code}`+(corrected?':recipient:'+createHash('sha256').update(candidate.phone).digest('hex').slice(0,20):'')
  const {data:claim,error:claimError}=await crm.from('integration_events').insert({provider:'vivenzza-approved-portfolio',event_type:'first_contact',external_id:claimKey,payload_hash:CAMPAIGN}).select('id').single()
  if(claimError){if(claimError.code==='23505'){record({code:entry.code,status:'skipped',reason:'abordagem_ja_reservada'});continue}throw Error('falha_reserva')}
  record({code:entry.code,name:entry.name,status:'reserved',message,totalCents:check.plan.totalCents,accountIds:check.plan.accountIds,started})
  // Dispatch recém-criado ainda não é contato: a consulta do revalidator só
  // considera sending/sent. Ignora apenas o dispatch desta mesma tentativa.
  const beforeAttempt=async({attemptNumber=1}={})=>{
   if(attemptNumber>1)await sleep(45000+Math.floor(Math.random()*45000))
   const own=await value(crm.from('collection_dispatches').select('id').eq('contas_financeiras_id',check.plan.representative).eq('etapa',8).gte('criado_em',since).eq('status','sending'))
   if(own.length===1)currentDispatchId=own[0].id
   return revalidate()
  }
  const result=await enviarCobrancaComRoteamento({contasFinanceirasId:check.plan.representative,etapa:8,clienteNome:entry.name,clienteTelefone:check.plan.phone,valor:check.plan.totalCents/100,mensagem:message,origem:'manual',beforeAttempt,correcaoDestinatario:corrected,financeiroAlternativoAutorizado:true})
  const status=result.motivo==='idempotencia_existente'?'skipped':result.status
  record({code:entry.code,name:entry.name,status,reason:result.reason||result.motivo||null,dispatchId:result.dispatchId||null,totalCents:check.plan.totalCents})
  // Só libera nossa reserva quando há prova de zero tentativas reais.
  if(['blocked','skipped'].includes(status)&&result.dispatchId){
   const r=await crm.from('collection_dispatch_attempts').select('id',{count:'exact',head:true}).eq('dispatch_id',result.dispatchId)
   if(r.error)throw Error('tentativas_inconclusivas_reserva_preservada')
   if(r.count===0){const release=await crm.from('integration_events').delete().eq('id',claim.id).eq('processing_status','pending');if(release.error)throw Error('liberacao_reserva_falhou')}
  }
  attempts++
  if(result.status==='failed'&&result.categoria!=='PERMANENT_RECIPIENT')break // erro de destinatário não derruba a carteira; falha técnica/incerta interrompe
  if(attempts<10)await sleep(45000+Math.floor(Math.random()*45000))
 }
} catch(e){console.error('batch_failed',e.code||e.message);process.exitCode=1}
finally{if(source)await source.end().catch(()=>{});fs.closeSync(fd);fs.unlinkSync(lock)}
