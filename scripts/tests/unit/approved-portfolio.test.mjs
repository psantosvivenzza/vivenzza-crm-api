import test from 'node:test'
import assert from 'node:assert/strict'
import { planCustomer, renderApprovedMessage, cents } from '../../../src/lib/collection/approvedPortfolio.js'
const entry = {code:'000001',name:'Cliente Sintético'}
const row = (extra = {}) => ({id:'a',legacy_id:'cr-10-1',codigo_cliente:'000001',pessoa_nome:entry.name,
  vencimento:'2026-10-01',status:'aberta',valor:'100.10',valor_pago:'10.01',telefone_cobranca:'51999999999',...extra})
const plan = rows => planCustomer(entry, rows, '2026-10-19')
test('soma dois boletos distintos e subtrai baixas em centavos', () => {
  const p=plan([row(),row({id:'b',legacy_id:'cr-11-1',valor:'200.20',valor_pago:'0'})])
  assert.equal(p.totalCents,29029); assert.equal(p.titles,2)
})
test('não duplica a mesma linha técnica', () => assert.equal(plan([row(),row()]).totalCents,9009))
test('aliases cr/001 distintos ficam bloqueados', () => assert.equal(plan([row(),row({id:'b',legacy_id:'001-10-1'})]).reason,'alias_financeiro_ambiguo'))
test('paga, cancelada, futura e vencendo hoje não entram', () => {
  const p=plan([row(),row({id:'b',legacy_id:'cr-11-1',status:'paga'}),row({id:'c',legacy_id:'cr-12-1',status:'cancelada'}),row({id:'d',legacy_id:'cr-13-1',vencimento:'2026-11-01'}),row({id:'e',legacy_id:'cr-14-1',vencimento:'2026-10-19'})])
  assert.equal(p.totalCents,9009); assert.equal(p.titles,1)
})
test('revisão, cadastro divergente e ausência de identidade bloqueiam', () => {
  assert.equal(plan([row({em_revisao_financeira:true})]).reason,'revisao_financeira')
  assert.equal(plan([row({pessoa_nome:'Outra Pessoa'})]).reason,'cadastro_divergente')
  assert.equal(plan([row({legacy_id:null})]).reason,'titulo_sem_identidade')
})
test('não inclui contas de fora da lista', () => assert.equal(plan([row({codigo_cliente:'000002'})]).reason,'sem_contas'))
test('telefones divergentes e inválidos não são enviados', () => {
  assert.equal(plan([row(),row({id:'b',legacy_id:'cr-11-1',telefone_cobranca:'11999999999'})]).reason,'telefone_divergente')
  assert.throws(()=>plan([row({telefone_cobranca:''})]),/telefone_invalido/)
})
test('valores não finitos, negativos ou precisão excedente são recusados', () => {
  for(const v of [NaN,Infinity,-1,'1.001',null,'']) assert.throws(()=>cents(v))
})
test('mensagem direta e firme não pede identidade nem ameaça CNH/bloqueio', () => {
  const p=planCustomer({...entry,process:'5000000-00.2026.8.21.0000'},[row()],'2026-10-19')
  const m=renderApprovedMessage(p)
  assert.match(m,/processo 5000000/); assert.doesNotMatch(m,/CNH|cassação|bloqueio|contato correto|confirme sua identidade/i)
})
test('encaminhamento Aníbal não vira processo fictício', () => {
  const p=planCustomer({...entry,referred:true},[row()],'2026-10-19')
  const m=renderApprovedMessage(p)
  assert.match(m,/encaminhamento/); assert.doesNotMatch(m,/processo \d/)
})
