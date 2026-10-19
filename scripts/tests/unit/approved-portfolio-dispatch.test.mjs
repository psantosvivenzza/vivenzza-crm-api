import test, {mock} from 'node:test'
import assert from 'node:assert/strict'
let sends=0, selections=0, attemptWrites=0
let existingDispatch=null,previousAttempts=[]
const updates=[]
mock.module('../../../src/lib/supabase-admin.server.js',{namedExports:{supabase:{from(table){
 let operation=null,payload,key=null
 const q={select(){return q},eq(k,v){if(k==='idempotency_key')key=v;return q},insert(v){operation='insert';payload=v;return q},update(v){operation='update';payload=v;updates.push([table,v]);return q},
 maybeSingle:async()=>({data:table==='collection_dispatches'&&key==='synthetic'?existingDispatch:null,error:null}),single:async()=>{
  if(table==='collection_dispatch_attempts')attemptWrites++
  return {data:{id:table==='collection_dispatches'?'dispatch':'attempt',...payload},error:null}
 },then(resolve,reject){return Promise.resolve({data:table==='collection_dispatch_attempts'&&operation===null?previousAttempts:null,error:null}).then(resolve,reject)}}
 return q
}}}})
mock.module('../../../src/lib/collection/featureFlags.js',{namedExports:{obterConfigCobranca:async()=>({whatsapp_failover:false})}})
mock.module('../../../src/lib/collection/idempotency.js',{namedExports:{idempotencyKeyDispatch:()=> 'synthetic',idempotencyKeyInternalTest:()=> 'test',registrarEventoExterno:async()=>({novo:true})}})
mock.module('../../../src/lib/collection/whatsappInstances.js',{namedExports:{selecionarProximaInstancia:async()=>{selections++;return{id:'instance',name:'synthetic'}},registrarSucessoEnvio:async()=>{},registrarFalhaEnvio:async()=>{}}})
mock.module('../../../src/lib/collection/evolutionAdapter.js',{namedExports:{enviarTexto:async()=>{sends++;return{providerMessageId:'fake'}},classifyEvolutionFailure:()=>({}),normalizarStatusAck:()=>null}})
mock.module('../../../src/lib/collection/paymentGuard.js',{namedExports:{statusQuitacaoTitulo:async()=>({quitado:false})}})
mock.module('../../../src/lib/collection/promises.js',{namedExports:{promessaAtivaPara:async()=>null}})
mock.module('../../../src/lib/collection/doNotContactGuard.js',{namedExports:{estaEmDoNotContact:async()=>({blocked:false}),registrarBloqueioOptOutSeNecessario:async()=>{},registrarBloqueioNumeroInvalidoHoje:async()=>{}}})
mock.module('../../../src/lib/collection/timeline.js',{namedExports:{registrarEvento:async()=>{},ORIGEM:{SYSTEM:'SYSTEM',HUMAN:'HUMAN',AUTOMATION:'AUTOMATION'}}})
mock.module('../../../src/lib/collection/collectionContactPolicy.js',{namedExports:{hojeBrtISO:()=> '2026-10-19'}})
mock.module('../../../src/lib/telefone.js',{namedExports:{telefonesEquivalentes:(a,b)=>a===b,mascararTelefone:()=> '****'}})
const {enviarComFailover}=await import('../../../src/lib/collection/dispatchEngine.js')
const args={contasFinanceirasId:'synthetic',etapa:8,clienteNome:'Sintético',clienteTelefone:'synthetic',valor:1,mensagem:'Teste',origem:'manual'}
test('revalidação negativa cancela antes de selecionar instância ou tentar provider',async()=>{
 const r=await enviarComFailover({...args,beforeAttempt:async()=>({allowed:false,reason:'pagamento_novo'})})
 assert.equal(r.status,'blocked');assert.equal(sends,0);assert.equal(selections,0);assert.equal(attemptWrites,0)
 assert.ok(updates.some(([,v])=>v.status==='cancelled'))
})
test('erro e retorno inconclusivo da revalidação falham fechados',async()=>{
 for(const beforeAttempt of [async()=>{throw Error('offline')},async()=>undefined]){
  const r=await enviarComFailover({...args,beforeAttempt});assert.equal(r.status,'blocked')
 }
 assert.equal(sends,0);assert.equal(attemptWrites,0)
})
test('só chama provider após revalidação explicitamente positiva',async()=>{
 let checked=false
 const r=await enviarComFailover({...args,beforeAttempt:async()=>{assert.equal(sends,0);checked=true;return {allowed:true}}})
 assert.equal(checked,true);assert.equal(r.status,'sent');assert.equal(sends,1);assert.equal(attemptWrites,1)
})
test('correção autorizada de outro telefone após permanent_recipient cria novo envio auditado',async()=>{
 existingDispatch={id:'old',status:'failed',cliente_telefone:'5551999999999'}
 previousAttempts=[{status:'failed',failure_kind:'permanent_recipient',provider_message_id:null,enviado_em:null}]
 const r=await enviarComFailover({...args,clienteTelefone:'5566992740000',correcaoDestinatario:true,beforeAttempt:async()=>({allowed:true})})
 assert.equal(r.status,'sent');assert.equal(sends,2)
 assert.equal(updates.some(([table,v])=>table==='collection_dispatches'&&v.cliente_telefone),false)
})
test('correção nunca repete resultado incerto, enviado, mesmo telefone ou sem ação humana',async()=>{
 const base={...args,clienteTelefone:'5566992740000',correcaoDestinatario:true,beforeAttempt:async()=>({allowed:true})}
 for(const attempts of [[{status:'failed',failure_kind:'technical',provider_message_id:null,enviado_em:null}],
  [{status:'failed',failure_kind:'permanent_recipient',provider_message_id:'provider',enviado_em:null}],[]]){
  previousAttempts=attempts;const r=await enviarComFailover(base);assert.equal(r.motivo,'idempotencia_existente')
 }
 previousAttempts=[{status:'failed',failure_kind:'permanent_recipient',provider_message_id:null,enviado_em:null}]
 assert.equal((await enviarComFailover({...base,clienteTelefone:existingDispatch.cliente_telefone})).motivo,'idempotencia_existente')
 assert.equal((await enviarComFailover({...base,origem:'cron'})).motivo,'idempotencia_existente')
 existingDispatch.status='delivered';assert.equal((await enviarComFailover(base)).motivo,'idempotencia_existente')
 assert.equal(sends,2)
})
