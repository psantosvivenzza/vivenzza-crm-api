import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { interpretarInventarioVoz } from '../../lib/voice-preflight-inventory.mjs'

const entrada = new URL('../../voice/verificar-servico-voz.mjs', import.meta.url).href
function executar(inventario, legado = '', falhar = false) {
  const child = `export function execFileSync(exe,args){
    if(${falhar})throw Object.assign(new Error('detalhe-sintetico-privado'),{code:'ETIMEDOUT'});
    if(exe!=='powershell.exe')throw Error('executavel inesperado');
    return args.join(' ').includes('ConvertTo-Json')?${JSON.stringify(JSON.stringify(inventario))}:${JSON.stringify(legado)};
  }`
  const bootstrap = `
    import {registerHooks} from 'node:module';
    registerHooks({resolve(s,c,next){
      if(s==='child_process')return {url:'mock:child',shortCircuit:true};
      if(s==='fs')return {url:'mock:fs',shortCircuit:true};
      if(s.startsWith('node:')||['path','url'].includes(s))return next(s,c);
      const r=next(s,c);
      if(![${JSON.stringify(entrada)},new URL('../lib/voice-preflight-inventory.mjs',${JSON.stringify(entrada)}).href].includes(r.url))throw Error('import bloqueado');
      return r;
    },load(url,c,next){
      if(url==='mock:child')return {format:'module',shortCircuit:true,source:${JSON.stringify(child)}};
      if(url==='mock:fs')return {format:'module',shortCircuit:true,source:"export default {readdirSync:()=>['servico.js'],statSync:()=>({mtime:new Date('2026-10-18T10:00:00Z')})}"};
      return next(url,c);
    }});
    await import(${JSON.stringify(entrada)});
  `
  const r=spawnSync(process.execPath,['--input-type=module','--eval',bootstrap],{
    encoding:'utf8',timeout:5000,env:{SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP},
  })
  assert.ifError(r.error)
  assert.equal(r.signal,null)
  return r
}

test('processo invisível não é diagnosticado como serviço parado',()=>{
  const r=executar({invisiveis:1,servicos:[]})
  assert.equal(r.status,1)
  assert.match(r.stdout,/NAO CONSEGUI CONFIRMAR/)
  assert.doesNotMatch(r.stdout,/SERVICO DE VOZ NAO ESTA NO AR|Liberado/)
})
test('inventário observável vazio confirma ausência e bloqueia',()=>{
  const r=executar({invisiveis:0,servicos:[]})
  assert.equal(r.status,1)
  assert.match(r.stdout,/SERVICO DE VOZ NAO ESTA NO AR/)
})
test('serviço identificado atual preserva liberação do preflight',()=>{
  const r=executar({invisiveis:0,servicos:[{pid:42,criadoEm:'2026-10-18T10:05:00Z'}]},'42|2026-10-18T10:05:00Z')
  assert.equal(r.status,0,r.stderr)
  assert.match(r.stdout,/Liberado/)
})
test('serviço identificado anterior ao código continua bloqueado',()=>{
  const r=executar({invisiveis:0,servicos:[{pid:42,criadoEm:'2026-10-18T09:00:00Z'}]},'42|2026-10-18T09:00:00Z')
  assert.equal(r.status,1)
  assert.match(r.stdout,/CODIGO VELHO/)
})
test('data inválida nunca autoriza discagem',()=>{
  const r=executar({invisiveis:0,servicos:[{pid:42,criadoEm:'invalida'}]},'42|invalida')
  assert.equal(r.status,1)
  assert.doesNotMatch(r.stdout,/Liberado/)
})
test('falha de consulta bloqueia sem registrar detalhe privado',()=>{
  const r=executar(null,'',true)
  assert.equal(r.status,1)
  assert.match(r.stdout,/NAO CONSEGUI CONFIRMAR/)
  assert.doesNotMatch(r.stdout+r.stderr,/detalhe-sintetico-privado/)
})

for (const valor of ['', 'null', '{}', '{', JSON.stringify({invisiveis:-1,servicos:[]}),
  JSON.stringify({invisiveis:0,servicos:null}),
  JSON.stringify({invisiveis:0,servicos:[{pid:0,criadoEm:'2026-10-18T10:05:00Z'}]}),
  JSON.stringify({invisiveis:0,servicos:[{pid:42,criadoEm:null}]}),
  JSON.stringify({invisiveis:0,servicos:[{pid:42,criadoEm:'2026-10-18T10:05:00Z'},{pid:43,criadoEm:'2026-10-18T10:05:00Z'}]}),
]) test('inventário inválido ou múltiplos serviços são inconclusivos: '+valor,()=>{
  assert.deepEqual(interpretarInventarioVoz(valor),{estado:'inconclusivo'})
})

for(const data of ['2001','2026-02-30T10:00:00Z','2026-10-19T00:00:00Z'])test('data não ISO, calendário inválido ou futura bloqueia: '+data,()=>{
  const json=JSON.stringify({invisiveis:0,servicos:[{pid:42,criadoEm:data}]})
  assert.deepEqual(interpretarInventarioVoz(json,Date.parse('2026-10-18T11:00:00Z')),{estado:'inconclusivo'})
})
test('timestamp UTC com sete casas do CIM é aceito',()=>{
  const json=JSON.stringify({invisiveis:0,servicos:[{pid:42,criadoEm:'2026-10-18T10:05:00.1234567Z'}]})
  const r=interpretarInventarioVoz(json,Date.parse('2026-10-18T11:00:00Z'))
  assert.equal(r.estado,'identificado')
  assert.equal(r.servico.criadoEm.toISOString(),'2026-10-18T10:05:00.123Z')
})
