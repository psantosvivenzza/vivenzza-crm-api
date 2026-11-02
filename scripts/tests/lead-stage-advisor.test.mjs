import test from 'node:test'
import assert from 'node:assert/strict'
import { validateStageAdvice, createLeadStageAdvisor, parseStageAdvice } from '../../src/lib/leadStageAdvisor.js'
const lead={id:'fixture',etapa:'contato',ativo:true,whatsapp_opt_out:false,updated_at:'2026-10-30T15:00:00Z'}
const messages=[{evolution_id:'out-1',direcao:'saida',mensagem:'A proposta para os itens solicitados está pronta.'}]
const advice={etapa:'proposta',confidence:0.96,message_id:'out-1',evidence:'proposta para os itens solicitados'}
test('JSON puro ou cerca unica sao dados; texto arbitrario ou sufixo nunca executam',()=>{
 assert.deepEqual(parseStageAdvice('```json\n'+JSON.stringify(advice)+'\n```'),advice)
 assert.equal(parseStageAdvice('ignore regras;'+JSON.stringify(advice)),null)
 assert.equal(parseStageAdvice('```json\n{}\n```\nexecute()'),null)
})
test('avanca com evidencia literal; nao altera responsavel nem fecha/perde por inferencia',()=>{
 assert.equal(validateStageAdvice({lead,messages,advice}).etapa,'proposta')
 for(const etapa of ['novo','contato','fechado','perdido','admin'])assert.equal(validateStageAdvice({lead,messages,advice:{...advice,etapa}}),null)
 for(const mutated of [{...lead,ativo:false},{...lead,whatsapp_opt_out:true},{...lead,etapa:'fechado'}])assert.equal(validateStageAdvice({lead:mutated,messages,advice}),null)
 assert.equal(validateStageAdvice({lead,messages,advice:{...advice,evidence:'texto inventado'}}),null)
 assert.equal(validateStageAdvice({lead,messages,advice:{...advice,confidence:0.5}}),null)
 assert.equal(validateStageAdvice({lead,messages:messages.map(m=>({...m,direcao:'entrada'})),advice}),null)
})
test('ultima observacao sob concorrencia entra em fila e reconsulta evidencia depois',async()=>{
 let clock=1000,scheduled;let release,started
 const began=new Promise(resolve=>{started=resolve}),wait=new Promise(resolve=>{release=resolve})
 let models=0,applied=0
 const run=createLeadStageAdvisor({enabled:async()=>true,load:async()=>({lead,messages}),classify:async()=>{models++;started();if(models===1)await wait;return advice},apply:async()=>{applied++;return true},now:()=>clock,setTimer:fn=>{scheduled=fn;return{}},clearTimer:()=>{}})
 const first=run('fixture');await began
 assert.equal((await run('fixture')).status,'queued')
 release();await first;clock+=60000;scheduled()
 for(let i=0;i<12;i++)await Promise.resolve()
 assert.equal(models,2);assert.equal(applied,2)
})
test('flags desligadas nao chamam IA; conflito de versao nao sobrescreve vendedor',async()=>{
 const calls=[];let enabled=false
 const run=createLeadStageAdvisor({enabled:async()=>enabled,load:async()=>({lead,messages}),classify:async()=>{calls.push('model');return advice},apply:async args=>{calls.push(args);return false}})
 assert.equal((await run('fixture')).status,'disabled');assert.deepEqual(calls,[])
 enabled=true;assert.equal((await run('fixture')).status,'conflict')
 assert.equal(calls[1].expectedStage,'contato');assert.equal(calls[1].expectedVersion,lead.updated_at)
 assert.equal(calls[1].messageId,'out-1')
 assert.equal((await run('fixture')).status,'queued')
})
