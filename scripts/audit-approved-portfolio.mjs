// Somente leitura. PDF e relatórios privados não devem ser commitados/enviados à memória.
import fs from 'node:fs'
import path from 'node:path'
import dns from 'node:dns/promises'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { planCustomer, cents, CAMPAIGN } from '../src/lib/collection/approvedPortfolio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const operational = path.join(root, 'vivenzza-crm-api')
const require = createRequire(path.join(operational, 'package.json'))
require('dotenv').config({path:path.join(operational,'.env'),quiet:true})
const {Client} = require('pg')
const {createClient} = require('@supabase/supabase-js')
export const reportPath=path.join(root,'output',`${CAMPAIGN}-private-audit.json`)
const pdf = 'C:\\Users\\msi\\Downloads\\atrasados.pdf'
const python='C:\\Users\\msi\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe'
const extraction = `from pypdf import PdfReader
import re,json,sys
t='\\n'.join(p.extract_text() for p in PdfReader(sys.argv[1]).pages)
ms=list(re.finditer(r'(?m)^(\\d{6})-(.*?)\\s+RG:',t)); out=[]
for i,m in enumerate(ms):
 b=t[m.end():ms[i+1].start() if i+1<len(ms) else len(t)]
 totals=re.findall(r'Total:\\s+([\\d.,]+)\\s+([\\d.,]+)',b)
 proc=re.search(r'PROCESSO JUR[IÍ]DICO:\\s*([\\d.-]+)',b,re.I)
 out.append(dict(code=m[1],name=m[2].strip(),pdfBalance=totals[-1][1].replace('.','').replace(',','.') if totals else None,process=proc[1] if proc else None,referred=bool(re.search(r'(?mi)^Obs:\\s*(?:ENVIAD[OA][^\\n]*ANIBAL|ANIBAL\\s*-)',b))))
print(json.dumps(out,ensure_ascii=True))`
export function entriesFromPdf() {
 const entries=JSON.parse(execFileSync(python,['-c',extraction,pdf],{encoding:'utf8',timeout:90000,maxBuffer:1048576,windowsHide:true}))
 if(entries.length!==120 || new Set(entries.map(e=>e.code)).size!==120) throw Error('lista_pdf_inconsistente')
 return entries
}
export function crmClient() {
 const url=process.env.SUPABASE_URL
 if(new URL(url).hostname!=='vkncsyhugotyfwmxpzgq.supabase.co') throw Error('projeto_incorreto')
 return createClient(url,process.env.SUPABASE_SECRET_KEY||process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}})
}
export async function sourceClient() {
 if(process.env.E01_DATABASE!=='e01')throw Error('origem_incorreta')
 let host
 try{host=(await dns.lookup(process.env.E01_HOST,{family:4})).address}catch{
  try{const c=JSON.parse(fs.readFileSync(path.join(operational,'.localdev/e01-host-cache.json'),'utf8'));if(c.host===process.env.E01_HOST)host=c.ip}catch{}
  host ||= process.env.E01_HOST_IP
 }
 if(!host)throw Error('origem_sem_host_verificado')
 const c=new Client({host,port:process.env.E01_PORT,user:process.env.E01_USER,password:process.env.E01_PASSWORD,database:process.env.E01_DATABASE,
 connectionTimeoutMillis:8000,query_timeout:15000,options:'-c default_transaction_read_only=on -c statement_timeout=12000'})
 await c.connect();return c
}
export async function loadAccounts(crm, codes) {
 const all=[]
 for(let offset=0;;offset+=1000){
  const {data,error}=await crm.from('contas_financeiras').select('id,codigo_cliente,pessoa_nome,legacy_id,valor,valor_pago,status,vencimento,telefone_cobranca,em_revisao_financeira,em_revisao').eq('tipo','receber').in('codigo_cliente',codes).order('id').range(offset,offset+999)
  if(error)throw Error('falha_leitura_crm');all.push(...data);if(data.length<1000)break
 }
 return all
}
export async function sourceRows(source,codes,today) {
 const {rows}=await source.query(`SELECT btrim("CodigoCliente") AS code,"NumeroTitulo" AS title,"Sequencia" AS sequence,
 to_char("DataVencimento",'YYYY-MM-DD') AS due,"ValorDuplicata"::numeric(18,2)::text AS amount,
 coalesce("ValorPago",0)::numeric(18,2)::text AS paid,coalesce("ValorParcialmentePago",0)::numeric(18,2)::text AS partial,
 "DuplicataAberta" AS open,"DataCancelamento" IS NOT NULL AS cancelled_date
 FROM "CR_Duplicatas" WHERE btrim("CodigoCliente")=ANY($1::text[]) AND "DataVencimento">=$2 AND "DataVencimento"<$3`,[codes,'2025-01-01',today])
 return rows
}
export function reconcile(entry,accounts,rows,today) {
 let plan
 try{plan=planCustomer(entry,accounts,today)}catch(e){return {code:entry.code,name:entry.name,status:'blocked',reason:e.message}}
 const raw=rows.filter(r=>r.code===entry.code && r.open && !['N','0','F','FALSE','NAO','NÃO'].includes(String(r.open).trim().toUpperCase()))
 const sourceCents=raw.reduce((s,r)=>s+Math.max(0,cents(r.amount)-cents(r.paid)-cents(r.partial)),0)
 let pdfCents
 try{pdfCents=cents(entry.pdfBalance)}catch{return {...plan,status:'blocked',reason:'saldo_pdf_invalido'}}
 const details={pdfCents,sourceCents,crmCents:plan.totalCents??null}
 if(raw.some(r=>r.cancelled_date && cents(r.amount)>cents(r.paid)+cents(r.partial)))return {...plan,status:'blocked',reason:'origem_aberta_com_data_cancelamento',...details}
 if(plan.status!=='ready')return {...plan,...details}
 const originKeys=new Set(raw.filter(r=>cents(r.amount)>cents(r.paid)+cents(r.partial)).map(r=>`${r.title}-${r.sequence}`))
 const current=accounts.filter(a=>plan.accountIds.includes(a.id))
 if(current.some(a=>!originKeys.has(a.legacy_id.replace(/^(?:cr|001)-/,''))))return {...plan,status:'blocked',reason:'titulo_sem_confirmacao_origem',...details}
 for(const a of current){
  const key=a.legacy_id.replace(/^(?:cr|001)-/,'')
  const matches=raw.filter(r=>`${r.title}-${r.sequence}`===key)
  if(matches.length!==1)return {...plan,status:'blocked',reason:'identidade_origem_ambigua',...details}
  const r=matches[0]
  if(cents(a.valor)!==cents(r.amount)||cents(a.valor_pago??0)!==cents(r.paid)+cents(r.partial)||a.vencimento!==r.due)return {...plan,status:'blocked',reason:'composicao_titulo_divergente',...details}
 }
 if(plan.totalCents!==sourceCents || details.pdfCents!==sourceCents)return {...plan,status:'blocked',reason:'saldo_pdf_origem_crm_divergente',...details}
 return {...plan,...details}
}
export async function audit() {
 const entries=entriesFromPdf(),crm=crmClient(),source=await sourceClient()
 try{
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'})
  const accounts=await loadAccounts(crm,entries.map(e=>e.code)), rows=await sourceRows(source,entries.map(e=>e.code),today)
  const plans=entries.map(e=>reconcile(e,accounts,rows,today))
  const report={campaign:CAMPAIGN,at:new Date().toISOString(),today,entries,plans}
  fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,JSON.stringify(report,null,2))
  const reasons={};for(const p of plans)reasons[p.reason||p.status]=(reasons[p.reason||p.status]||0)+1
  console.log(JSON.stringify({campaign:CAMPAIGN,clients:plans.length,reasons,report:reportPath}))
  return report
 }finally{await source.end()}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const deadline=setTimeout(()=>{console.error('audit_timeout');process.exit(2)},180000)
 try{await audit()}catch(e){console.error('audit_failed',e.code||e.message);process.exitCode=1}finally{clearTimeout(deadline)}
}
