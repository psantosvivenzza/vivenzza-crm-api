import test from 'node:test'
import assert from 'node:assert/strict'
import { validateVoiceAudit, validateVoiceCandidate, voiceWindow } from '../../../src/lib/voice/approvedPortfolioScope.js'
const now = new Date('2026-10-19T15:00:00Z')
const entries = Array.from({length: 120}, (_, i) => ({code: String(i).padStart(6, '0'), name: 'Sintético'}))
const audit = { campaign: 'atrasados-20261019', at: now.toISOString(), today: '2026-10-19', entries, plans: entries.map(e => ({...e, status: 'blocked'})) }
test('lista exata e auditoria recente são obrigatórias', () => {
 assert.deepEqual(validateVoiceAudit(audit, entries, now), [])
 for(const invalid of [{...audit,at:'invalid'}, {...audit,at:'2026-10-19T15:01:00Z'}, {...audit,at:'2026-10-19T14:29:59Z'}, {...audit,campaign:'outra'}, {...audit,entries:[]}]) assert.throws(()=>validateVoiceAudit(invalid,entries,now))
 assert.throws(()=>validateVoiceAudit({...audit,plans:[]},entries,now))
})
test('somente planos conciliados entram na seleção', () => {
 const plans=audit.plans.map((p,i)=>({...p,status:i===4?'ready':'blocked'}))
 assert.deepEqual(validateVoiceAudit({...audit,plans},entries,now), ['000004'])
})
test('janela usa Brasília e preserva dias úteis 09–17', () => {
 for(const time of ['2026-10-19T11:59:59Z','2026-10-19T20:00:00Z','2026-10-18T15:00:00Z']) assert.equal(voiceWindow(new Date(time)),false)
 for(const time of ['2026-10-19T12:00:00Z','2026-10-19T19:59:59Z']) assert.equal(voiceWindow(new Date(time)),true)
})
const saved={code:'000004',name:'Sintético',phone:'5511999998888',totalCents:30000,accountIds:['boleto1','boleto2'],status:'ready'}
const candidate={codigo_cliente:'000004',cliente:'Sintético',telefone:'11999998888',valor_total:'300.00'}
test('somente cliente/telefone/boletos/total confirmados passam', () => {
 assert.equal(validateVoiceCandidate(candidate,saved,{...saved}),true)
 for(const changed of [{code:'000005'},{status:'blocked'},{phone:'5511999997777'},{totalCents:29999},{accountIds:['boleto1'] }]) assert.throws(()=>validateVoiceCandidate(candidate,saved,{...saved,...changed}))
 assert.throws(()=>validateVoiceCandidate({...candidate,valor_total:'301.00'},saved,saved))
 assert.throws(()=>validateVoiceCandidate({...candidate,codigo_cliente:'000005'},saved,saved))
 assert.throws(()=>validateVoiceCandidate(candidate,null,saved))
})
