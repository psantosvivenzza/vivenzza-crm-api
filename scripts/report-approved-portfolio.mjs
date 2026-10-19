import fs from 'node:fs'
import path from 'node:path'
import { crmClient, reportPath } from './audit-approved-portfolio.mjs'
import { CAMPAIGN } from '../src/lib/collection/approvedPortfolio.js'
import { telefonesEquivalentes } from '../src/lib/telefone.js'
const crm=crmClient(), root=path.dirname(reportPath)
const audit=JSON.parse(fs.readFileSync(reportPath,'utf8'))
const journal=path.join(root,`${CAMPAIGN}-private-dispatch.jsonl`)
const events=fs.existsSync(journal)?fs.readFileSync(journal,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[]
const since=events[0]?.at||audit.at
if(!Number.isFinite(Date.parse(since)))throw Error('relatorio_sem_data_confiavel')
const read=async q=>{const r=await q;if(r.error)throw Error('relatorio_consulta_falhou');return r.data||[]}
const pages=async build=>{const all=[];for(let n=0;n<10000;n+=1000){const part=await read(build().order('id').range(n,n+999));all.push(...part);if(part.length<1000)return all}throw Error('relatorio_truncado')}
const dispatchIds=[...new Set(events.map(e=>e.dispatchId).filter(Boolean))]
const attempts=dispatchIds.length?await pages(()=>crm.from('collection_dispatch_attempts').select('id,dispatch_id,status,provider_message_id,enviado_em,entregue_em,lido_em,failure_kind').in('dispatch_id',dispatchIds)):[]
const messages=await pages(()=>crm.from('whatsapp_mensagens').select('id,telefone,mensagem,created_at,instance_name').eq('direcao','entrada').gte('created_at',since).in('instance_name',['vivenzza-financeiro','vivenzza-financeiro-reserva-01','vivenzza-financeiro-reserva-02']))
const clients=audit.plans.map(p=>{
 const own=events.filter(e=>e.code===p.code),last=own.at(-1),sent=own.findLast(e=>e.dispatchId)
 const ownIds=new Set(own.map(e=>e.dispatchId).filter(Boolean))
 const real=attempts.filter(a=>ownIds.has(a.dispatch_id)&&(!a.enviado_em||Date.parse(a.enviado_em)>=Date.parse(since)))
 const replies=p.phone?messages.filter(m=>telefonesEquivalentes(m.telefone,p.phone)):[]
 const sentConfirmed=real.some(a=>a.enviado_em&&a.provider_message_id)
 const communicationStatus=replies.length?'respondida':real.some(a=>a.lido_em)?'read':real.some(a=>a.entregue_em)?'delivered':sentConfirmed?'sent':real.some(a=>a.status==='failed')?'failed':last?.status||p.status
 return {code:p.code,name:p.name,pdfCents:p.pdfCents,sourceCents:p.sourceCents,crmCents:p.crmCents,
 status:communicationStatus,reason:sentConfirmed?null:last?.reason||p.reason||null,lastGuardReason:last?.reason||null,message:own.findLast(e=>e.message)?.message||null,
 dispatchId:sent?.dispatchId||null,attempts:real,replies,
 responseStatus:replies.length?'resposta_registrada':real.some(a=>a.enviado_em)?'sem_resposta_registrada_ate_consulta':'nao_se_aplica_sem_envio_confirmado',
 nextAction:replies.length?'atendimento_humano_sem_insistencia':sentConfirmed?'aguardar_retorno_sem_reenvio':real.some(a=>a.failure_kind==='permanent_recipient')?'corrigir_contato_na_NetVision_sem_reenvio':p.status==='blocked'?'reconciliar_pendencia_sem_cobrar':last?.status==='failed'?'investigar_sem_repetir_resultado_incerto':'aguardar_envio_ou_protecao'}
})
const at=new Date().toISOString(), out=path.join(root,`${CAMPAIGN}-private-followup.json`)
fs.writeFileSync(out,JSON.stringify({campaign:CAMPAIGN,at,since,clients},null,2))
const safe=s=>String(s??'—').replace(/[|\r\n]/g,' ')
const brl=n=>n==null?'—':(n/100).toLocaleString('pt-BR',{style:'currency',currency:'BRL'})
const local=d=>d?new Date(d).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}):'—'
const lines=[`# Acompanhamento da lista autorizada — ${local(at)}`,'',
 'Consulta real, não previsão. Aceite pelo provedor, entrega, leitura e retorno são estados diferentes. Retornos abaixo são os observados desde o início da operação; não comprovam resposta à mensagem específica. Contatos @lid sem resolução para telefone podem não ser associados: ausência de retorno associado não prova que a pessoa não respondeu.','',
 '| Código | Cliente | Saldo PDF | Saldo origem | Saldo CRM | Situação / motivo | Envio | Entrega | Leitura | Retornos observados | Próxima ação |',
 '|---|---|---:|---:|---:|---|---|---|---|---:|---|']
for(const c of clients){const a=c.attempts.findLast(a=>a.enviado_em&&a.provider_message_id)||c.attempts.at(-1);lines.push(`| ${[c.code,c.name,brl(c.pdfCents),brl(c.sourceCents),brl(c.crmCents),`${c.status}${c.reason?' / '+c.reason:''}`,a?.enviado_em&&!a?.provider_message_id?'sem ID do provedor':local(a?.enviado_em),local(a?.entregue_em),local(a?.lido_em),c.replies.length,c.nextAction].map(safe).join(' | ')} |`)}
fs.writeFileSync(path.join(root,`${CAMPAIGN}-acompanhamento.md`),lines.join('\n')+'\n')
console.log(JSON.stringify({at,clients:clients.length,sentConfirmed:clients.filter(c=>c.attempts.some(a=>a.enviado_em&&a.provider_message_id)).length,
 delivered:clients.filter(c=>c.attempts.some(a=>a.entregue_em)).length,read:clients.filter(c=>c.attempts.some(a=>a.lido_em)).length,
 replied:clients.filter(c=>c.replies.length).length,report:out}))
