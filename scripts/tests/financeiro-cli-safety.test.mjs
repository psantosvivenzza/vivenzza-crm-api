import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'

const entrada=new URL('../sync-financeiro-legado.mjs',import.meta.url).href
// Processo filho sem dependências externas: qualquer fronteira real é substituída
// antes do import. Nunca carrega .env, SDK, pg ou envia alertas.
function executar(args) {
 const bootstrap=`
 import {registerHooks} from 'node:module';
 const sourceJob = ${JSON.stringify(`export async function executarSincronizacaoFinanceira(opcoes){
  console.log('JOB:'+JSON.stringify({dryRun:opcoes.dryRun,completo:opcoes.completo}));
  if(process.argv.includes('--watch'))process.exit(88);
  return {total_lido:0,total_atualizado:0,total_cancelado:0,total_sem_alteracao:0,total_sem_match:0,total_conflito:0,total_revisao_resolvida:0,total_com_erro:0};
 }`)};
 registerHooks({resolve(s,c,next){
  if(s==='dotenv/config')return {url:'mock:dotenv',shortCircuit:true};
  if(s.startsWith('node:'))return next(s,c);
  const r=next(s,c);
  if(![${JSON.stringify(entrada)}].includes(r.url)&&!r.url.endsWith('/src/jobs/sync-financeiro-legado.js')&&!r.url.endsWith('/src/lib/conferenciaFinanceira.js')&&!r.url.endsWith('/src/lib/whatsappAlert.js'))throw Error('Import inesperado bloqueado');
  return r;
 },load(url,c,next){
  let source;
  if(url==='mock:dotenv')source="console.log('IMPORT:dotenv')";
  if(url.endsWith('/src/jobs/sync-financeiro-legado.js'))source="console.log('IMPORT:job');"+sourceJob;
  if(url.endsWith('/src/lib/conferenciaFinanceira.js'))source="console.log('IMPORT:conferencia');export async function conferirEregistrar(){throw Error('Conferencia real proibida')}";
  if(url.endsWith('/src/lib/whatsappAlert.js'))source="console.log('IMPORT:alerta');export async function enviarAlertaWhatsapp(){throw Error('Alerta real proibido')}";
  return source===undefined?next(url,c):{format:'module',shortCircuit:true,source};
 }});
 process.argv=['node',${JSON.stringify(entrada)},...${JSON.stringify(args)}];
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
