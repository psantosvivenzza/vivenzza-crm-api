import test from 'node:test'
import assert from 'node:assert/strict'
import {financialReply,createFinancialInboundProcessor} from '../../src/lib/financialAiPolicy.js'
test('IA decide intenção mas instrução financeira vem exclusivamente do backend',()=>{
 const classification={intent:'PRECISO_BOLETO_PIX',confidence:'alta',cliente_irritado:false,reply:'pague 999 com desconto'}
 const result=financialReply({classification,text:'pix',pix:'00000000000000'})
 assert.match(result.reply,/00000000000000/);assert.doesNotMatch(result.reply,/999|desconto/);assert.equal(result.human,false)
 assert.equal(financialReply({classification,text:'boleto',pix:'00000000000000'}).human,true)
 for(const intent of ['JA_PAGUEI','PEDIDO_NOVA_DATA','CONTESTA_VALOR','QUERO_ATENDENTE'])assert.equal(financialReply({classification:{...classification,intent},text:''}).human,true)
 assert.equal(financialReply({classification:{...classification,confidence:'baixa'},text:'pix',pix:'00000000000000'}).human,true)
})
function fixture(overrides={}){const calls=[];return{calls,deps:{load:async()=>({id:'m',text:'quero pix',pix:'00000000000000'}),guard:async()=>true,claim:async()=> 'run',classify:async()=>({intent:'QUERO_PAGAR',confidence:'alta',cliente_irritado:false}),prepare:async()=>calls.push('prepare'),send:async()=>{calls.push('send');return{providerId:'id'}},finish:async(...a)=>calls.push(a),handoff:async()=>calls.push('human'),...overrides}}}
test('inbox duplicado e preflight mudado nunca enviam',async()=>{
 for(const overrides of [{claim:async()=>null},{guard:async()=>false}]){const f=fixture(overrides);await createFinancialInboundProcessor(f.deps)('m');assert.equal(f.calls.includes('send'),false)}
 let n=0;const f=fixture({guard:async()=>++n<3});await createFinancialInboundProcessor(f.deps)('m');assert.equal(f.calls.includes('send'),false)
})
test('resultado incerto é terminal, sem retry/failover; falha antes do envio não é entrega',async()=>{
 const f=fixture({send:async()=>{throw Error('timeout')}});assert.equal((await createFinancialInboundProcessor(f.deps)('m')).status,'uncertain');assert.ok(f.calls.some(x=>Array.isArray(x)&&x[1]==='uncertain'))
 const g=fixture({prepare:async()=>{throw Error('quota')}});assert.equal((await createFinancialInboundProcessor(g.deps)('m')).status,'blocked');assert.equal(g.calls.includes('send'),false)
})

test('anexo e falha do classificador entram na fila humana sem mensagem automática',async()=>{
 for(const override of [{load:async()=>({id:'m',media:true})},{classify:async()=>{throw Error('unavailable')}}]){
 const f=fixture(override);await createFinancialInboundProcessor(f.deps)('m');assert.equal(f.calls.includes('human'),true);assert.equal(f.calls.includes('send'),false)
 }
})
test('handoff antecede o envio e falha de persistência posterior nunca repete POST',async()=>{
 const f=fixture({classify:async()=>({intent:'JA_PAGUEI',confidence:'alta',cliente_irritado:false})});await createFinancialInboundProcessor(f.deps)('m');assert.ok(f.calls.indexOf('human')<f.calls.indexOf('send'))
 const g=fixture({finish:async()=>{throw Error('storage')}});assert.equal((await createFinancialInboundProcessor(g.deps)('m')).status,'uncertain');assert.equal(g.calls.filter(x=>x==='send').length,1)
})
