import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

const entrada=new URL('../sync-financeiro-legado.mjs',import.meta.url).href
// Processo filho sem dependências externas: qualquer fronteira real é substituída
// antes do import. Nunca carrega .env, SDK, pg ou envia alertas.
function executar(args, {ciclo=false, falha=null}={}) {
 const conferencia = `console.log('IMPORT:conferencia');export async function conferirEregistrar(){
  console.log('CONFERENCIA');
  if(${JSON.stringify(falha === 'conferencia')})throw Error('falha sintetica');
  return {bateu:false,criticas:1,erp:{abertos:0,saldo:0},crm:{abertos:1,saldo:0},contagens:{crm_aberto_erp_fechado:1,crm_fechado_erp_aberto:0,valor_pago_diferente:0}};
 }`
 const alerta = `console.log('IMPORT:alerta');export async function enviarAlertaWhatsapp(){
  console.log('ALERTA');if(${JSON.stringify(falha === 'alerta')})throw Error('falha sintetica');
 }`
 const bootstrap=`
 import {registerHooks} from 'node:module';
 import {writeSync} from 'node:fs';
 import {format} from 'node:util';
 // FDs herdados do subprocesso: descarrega antes do exit controlado no Windows.
 console.log=(...args)=>writeSync(1,format(...args)+'\\n');
 console.error=(...args)=>writeSync(2,format(...args)+'\\n');
 const sourceJob = ${JSON.stringify(`export async function executarSincronizacaoFinanceira(opcoes){
  console.log('JOB:'+JSON.stringify({dryRun:opcoes.dryRun,completo:opcoes.completo}));
  if(FALHA_JOB)throw Error('falha sintetica');
  if(process.argv.includes('--watch') && !ciclo)process.exit(88);
  return {total_lido:0,total_atualizado:0,total_cancelado:0,total_sem_alteracao:0,total_sem_match:0,total_conflito:0,total_revisao_resolvida:0,total_com_erro:0};
 }`.replace('!ciclo', JSON.stringify(!ciclo)).replace('FALHA_JOB', JSON.stringify(falha === 'job')))};
 registerHooks({resolve(s,c,next){
  if(s==='dotenv/config')return {url:'mock:dotenv',shortCircuit:true};
  if(s.startsWith('node:'))return next(s,c);
  const r=next(s,c);
  if(![${JSON.stringify(entrada)}].includes(r.url)&&!r.url.endsWith('/scripts/lib/financeiro-phase.mjs')&&!r.url.endsWith('/src/jobs/sync-financeiro-legado.js')&&!r.url.endsWith('/src/lib/conferenciaFinanceira.js')&&!r.url.endsWith('/src/lib/whatsappAlert.js'))throw Error('Import inesperado bloqueado');
  return r;
 },load(url,c,next){
  let source;
  if(url==='mock:dotenv')source="console.log('IMPORT:dotenv')";
  if(url.endsWith('/src/jobs/sync-financeiro-legado.js'))source="console.log('IMPORT:job');"+sourceJob;
  if(url.endsWith('/src/lib/conferenciaFinanceira.js'))source=${JSON.stringify(conferencia)};
  if(url.endsWith('/src/lib/whatsappAlert.js'))source=${JSON.stringify(alerta)};
  return source===undefined?next(url,c):{format:'module',shortCircuit:true,source};
 }});
 process.argv=['node',${JSON.stringify(entrada)},...${JSON.stringify(args)}];
 if(${JSON.stringify(ciclo)})globalThis.setTimeout=()=>process.exit(89); // parar no descanso, após o ciclo sintético
 await import(${JSON.stringify(entrada)});
 `
 const r=spawnSync(process.execPath,['--input-type=module','--eval',bootstrap],{
  encoding:'utf8',timeout:5000,env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP},
 })
 assert.ifError(r.error)
 assert.equal(r.signal,null)
 return r
}

for(const args of [
 ['--dry-run','--watch'],['--watch','--dry-run'],
 ['--completo','--watch','--dry-run'],['--dry-run','--dry-run','--watch'],
])test(`recusa ${args.join(' ')} antes de importar adaptadores`,()=>{
 const r=executar(args)
 assert.equal(r.status,2)
 assert.match(r.stderr,/--watch.*--dry-run|--dry-run.*--watch/)
 assert.doesNotMatch(r.stdout,/IMPORT:|JOB:/)
})

for(const [args,esperado] of [
 [[],{dryRun:false,completo:false}],
 [['--completo'],{dryRun:false,completo:true}],
 [['--dry-run'],{dryRun:true,completo:true}],
])test(`modo pontual mantém opções ${args.join(' ')||'padrão'}`,()=>{
 const r=executar(args)
 assert.equal(r.status,0,r.stderr)
 const linha=r.stdout.split(/\r?\n/).find(l=>l.startsWith('JOB:'))
 assert.deepEqual(JSON.parse(linha.slice(4)),esperado)
 const etapas=r.stderr.split(/\r?\n/).filter(l=>l.startsWith('{')).map(l=>JSON.parse(l))
 const fase=esperado.completo?'sincronizacao_completa':'sincronizacao_incremental'
 assert.deepEqual(etapas.map(e=>[e.etapa,e.evento]),[[fase,'inicio'],[fase,'fim']])
})

for(const args of [
 ['--watch','--dry-run=true'],['--watch','--dryrun'],['--watch','-n'],
 ['--watch','--desconhecido=valor-sensivel-sintetico'],['--desconhecido'],
])test(`argumento desconhecido é recusado sem carregar adaptadores: ${args[0]}`,()=>{
 const r=executar(args)
 assert.equal(r.status,2)
 assert.match(r.stderr,/Argumentos não reconhecidos/)
 assert.doesNotMatch(r.stdout,/IMPORT:|JOB:/)
 assert.doesNotMatch(r.stderr,/valor-sensivel-sintetico/)
})

test('watch sem dry-run ainda chega ao job com varredura completa inicial (stub)',()=>{
 const r=executar(['--watch'])
 assert.equal(r.status,88,r.stderr)
 const linha=r.stdout.split(/\r?\n/).find(l=>l.startsWith('JOB:'))
 assert.deepEqual(JSON.parse(linha.slice(4)),{completo:true})
})

for(const falha of [null, 'conferencia', 'alerta'])test(`ciclo watch sintético registra sequência de etapas (${falha ?? 'sucesso'})`,()=>{
 const r=executar(['--watch'],{ciclo:true,falha})
 assert.equal(r.status,89,r.stderr)
 const eventos=r.stderr.split(/\r?\n/).filter(l=>l.startsWith('{')).map(l=>JSON.parse(l))
 const esperado=[['sincronizacao_completa','inicio'],['sincronizacao_completa','fim'],
  ['conferencia','inicio'],['conferencia',falha==='conferencia'?'erro':'fim']]
 if(falha!=='conferencia')esperado.push(['alerta','inicio'],['alerta',falha==='alerta'?'erro':'fim'])
 assert.deepEqual(eventos.map(e=>[e.etapa,e.evento]),esperado)
 assert.equal(r.stdout.split(/\r?\n/).filter(l=>l.startsWith('JOB:')).length,1)
 assert.equal(r.stdout.split(/\r?\n/).filter(l=>l==='ALERTA').length,falha==='conferencia'?0:1)
 if(falha==='alerta')assert.match(r.stderr,/nao consegui enviar o alerta/)
})

test('falha pontual mantém exit 1 e registra erro da etapa',()=>{
 const r=executar(['--dry-run'],{falha:'job'})
 assert.equal(r.status,1,r.stderr)
 assert.match(r.stderr,/FALHOU:/)
 const etapas=r.stderr.split(/\r?\n/).filter(l=>l.startsWith('{')).map(l=>JSON.parse(l))
 assert.deepEqual(etapas.map(e=>[e.etapa,e.evento]),[['sincronizacao_completa','inicio'],['sincronizacao_completa','erro']])
 assert.equal(r.stdout.split(/\r?\n/).filter(l=>l.startsWith('JOB:')).length,1)
})
