// Correção de contato expressamente autorizada, nunca baixa/status/valor.
import {entriesFromPdf,sourceClient,crmClient} from './audit-approved-portfolio.mjs'
import {normalizeName,phoneKey} from '../src/lib/collection/approvedPortfolio.js'
import fs from 'node:fs'
import path from 'node:path'
import {reportPath} from './audit-approved-portfolio.mjs'
import {candidatosTelefone,telefonesEquivalentes} from '../src/lib/telefone.js'
const args=process.argv.slice(2),apply=args.includes('--apply')
const code=args[args.indexOf('--code')+1],phone=args[args.indexOf('--phone')+1]
if(code!=='002009'||!phone)throw Error('fora_autorizacao_especifica')
const canonical=phoneKey(phone),local=canonical.slice(2)
if(!/^55[1-9]\d9\d{8}$/.test(canonical))throw Error('celular_invalido')
const entry=entriesFromPdf().find(e=>e.code===code)
const source=await sourceClient(),crm=crmClient()
try{
 const {rows}=await source.query('SELECT "CodigoPessoa","Nome","Celular" FROM "Pessoas" WHERE btrim("CodigoPessoa")=$1',[code])
 if(rows.length!==1||normalizeName(rows[0].Nome)!==normalizeName(entry.name))throw Error('identidade_origem_divergente')
 const customer=await crm.from('clientes_erp').select('id,legacy_id,razao_social,contatos').eq('legacy_id',code).single()
 if(customer.error||normalizeName(customer.data.razao_social)!==normalizeName(entry.name))throw Error('identidade_crm_divergente')
 if(!Array.isArray(customer.data.contatos)||customer.data.contatos.some(c=>!c||typeof c!=='object'||Array.isArray(c)||typeof c.tipo!=='string'||typeof c.valor!=='string'))throw Error('contatos_formato_inesperado')
 const variants=candidatosTelefone(canonical)
 const dup=await source.query(`SELECT count(*)::integer AS n FROM "Pessoas" WHERE btrim("CodigoPessoa")<>$1 AND
 (regexp_replace(coalesce("Celular",''),'[^0-9]','','g')=ANY($2::text[]) OR regexp_replace(coalesce("Fone",''),'[^0-9]','','g')=ANY($2::text[]))`,[code,variants])
 if(dup.rows[0].n>0)throw Error('telefone_pertence_outro_cadastro')
 const otherAccounts=await crm.from('contas_financeiras').select('id').in('telefone_cobranca',variants).or(`codigo_cliente.is.null,codigo_cliente.neq.${code}`).limit(1)
 if(otherAccounts.error||otherAccounts.data?.length)throw Error('contato_crm_compartilhado_ou_inconclusivo')
 for(let offset=0;;offset+=1000){
  const others=await crm.from('clientes_erp').select('legacy_id,contatos').neq('legacy_id',code).order('id').range(offset,offset+999)
  if(others.error)throw Error('consulta_contatos_globais_falhou')
  if(others.data.some(c=>Array.isArray(c.contatos)&&c.contatos.some(v=>v?.valor&&telefonesEquivalentes(v.valor,canonical))))throw Error('contato_crm_compartilhado')
  if(others.data.length<1000)break
 }
 console.log(JSON.stringify({code,name:entry.name,apply,phoneLast4:local.slice(-4),phase:'verified'}))
 if(apply){
  const backup=path.join(path.dirname(reportPath),`atrasados-20261019-private-contact-${code}-${Date.now()}.json`)
  fs.writeFileSync(backup,JSON.stringify({at:new Date().toISOString(),code,oldMobile:rows[0].Celular,oldContacts:customer.data.contatos,newMobile:local},null,2),{flag:'wx'})
  // A conexão tem default readonly. Somente esta transação explicitamente
  // autorizada é read-write e atualiza um campo de um cadastro identificado.
  await source.query('BEGIN READ WRITE')
  try{
   const changed=await source.query('UPDATE "Pessoas" SET "Celular"=$1 WHERE btrim("CodigoPessoa")=$2 AND "Nome"=$3 AND "Celular" IS NOT DISTINCT FROM $4 RETURNING "CodigoPessoa"',[local,code,rows[0].Nome,rows[0].Celular])
   if(changed.rowCount!==1)throw Error('cadastro_alterado_concorrentemente')
   await source.query('COMMIT')
  }catch(e){await source.query('ROLLBACK');throw e}
  // Fonte primeiro. Se a propagação falhar, é reportada, nunca desfaz contato
  // correto na origem nem altera qualquer recebimento para esconder a falha.
  const contacts=Array.isArray(customer.data.contatos)?customer.data.contatos:[]
  const next=[{tipo:'celular',valor:local},...contacts.filter(c=>String(c.tipo||'').toLowerCase()!=='celular')]
  const updated=await crm.from('clientes_erp').update({contatos:next}).eq('id',customer.data.id).eq('legacy_id',code).filter('contatos','eq',JSON.stringify(customer.data.contatos)).select('id')
  if(updated.error||updated.data?.length!==1)throw Error('origem_corrigida_propagacao_cadastro_pendente')
  // Trigger real muda aberta vencida para vencida em qualquer UPDATE. Não
  // atingir esse estado aqui: esta autorização é de contato, não de situação.
  const accounts=await crm.from('contas_financeiras').update({telefone_cobranca:local}).eq('codigo_cliente',code).eq('tipo','receber').in('status',['paga','vencida','pago_parcial','cancelada']).select('id')
  if(accounts.error||!accounts.data?.length)throw Error('origem_corrigida_propagacao_telefone_pendente')
  const check=await source.query('SELECT "Celular" FROM "Pessoas" WHERE btrim("CodigoPessoa")=$1',[code])
  const mirror=await crm.from('clientes_erp').select('contatos').eq('id',customer.data.id).single()
  const accountCheck=await crm.from('contas_financeiras').select('id').eq('codigo_cliente',code).eq('tipo','receber').or(`telefone_cobranca.is.null,telefone_cobranca.neq.${local}`).limit(1)
  if(check.rows.length!==1||phoneKey(check.rows[0].Celular)!==canonical||mirror.error||!Array.isArray(mirror.data?.contatos)||phoneKey(mirror.data.contatos.find(c=>c?.tipo==='celular')?.valor)!==canonical||accountCheck.error||accountCheck.data?.length)throw Error('verificacao_final_falhou')
  fs.writeFileSync(path.join(path.dirname(reportPath),'atrasados-20261019-private-recipient-correction.json'),JSON.stringify({code,phone:canonical,verifiedAt:new Date().toISOString(),sourceVerified:true,crmVerified:true}))
  console.log(JSON.stringify({code,phase:'contact_corrected_and_verified',accountsUpdated:accounts.data.length,phoneLast4:local.slice(-4)}))
 }
}catch(e){console.error('contact_correction_failed',e.code||e.message);process.exitCode=1}
finally{await source.end()}
