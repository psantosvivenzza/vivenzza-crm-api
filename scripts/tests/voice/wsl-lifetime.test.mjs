import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { manterWslDuranteServico } from '../../voice/wsl-lifetime.mjs'

test('nao inicia WSL em host nao Windows', () => {
  assert.equal(manterWslDuranteServico({platform:'linux',spawnFn:()=>{throw Error('nao chamar')}}), null)
})
test('ancora sem prazo acompanha o servico e falha fechado se terminar', () => {
  const child = new EventEmitter(); child.kill = () => {}
  const host = new EventEmitter(); let code; host.exit = c => {code=c}
  manterWslDuranteServico({platform:'win32',host,spawnFn:(cmd,args,opts)=>{
    assert.equal(cmd,'wsl.exe'); assert.equal(args.at(-1),'infinity'); assert.equal(opts.windowsHide,true); return child
  }})
  child.emit('exit',0); assert.equal(code,1)
})
test('saida normal encerra somente a propria ancora', () => {
  const child = new EventEmitter(); let killed=false; child.kill=()=>{killed=true;child.emit('exit',0)}
  const host = new EventEmitter(); host.exit=()=>{throw Error('nao falhar ao encerrar')}
  manterWslDuranteServico({platform:'win32',host,spawnFn:()=>child})
  host.emit('exit',0); assert.equal(killed,true)
})
