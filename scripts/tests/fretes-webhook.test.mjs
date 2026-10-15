// Apenas banco sintético configurado por LOCAL_PG_PORT/DATABASE e fake Evolution.
import test from 'node:test'
import assert from 'node:assert/strict'
import { iniciarAmbienteDeTeste, pararAmbienteDeTeste, limparInstanciasDeTeste } from './collection/_setup.mjs'
process.env.FRETE_MODULO_INSTALADO = 'true'
process.env.FRETE_IA_ATIVA = 'false'
let db, processEvent, supplier, cobranca, cotacao
const phone = '5551999990222'
const eventIds = ['frete-sem-solicitacao-teste', 'frete-falha-classificacao-teste', 'frete-solicitacao-aberta-teste']
function event(id) { return { event: 'messages.upsert', instance: 'vivenzza-financeiro', data: { key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id }, message: { conversation: 'Qual peso?' } } } }
const check = r => { if(r.error) throw r.error; return r.data }
test.before(async () => {
 await iniciarAmbienteDeTeste()
 db = (await import('../../src/lib/supabase-admin.server.js')).supabase
 processEvent = (await import('../../src/routes/webhook-handler.js')).processWhatsappEvent
 await limparInstanciasDeTeste(db)
 check(await db.from('whatsapp_instances').insert({ name: 'Financeiro sintético', instance_name: 'vivenzza-financeiro', priority: 1, role: 'principal', enabled: true }))
 ;(await import('../../src/lib/collection/whatsappInstances.js'))._resetCacheInstanciasFinanceirasParaTeste()
 supplier = check(await db.from('fornecedores').insert({ cnpj: `SINT-${Date.now()}`, razao_social: 'Transportadora sintética', participa_cotacao_frete: true, telefone_cotacao_frete: phone, cotacao_frete_consentimento: true }).select().single())
 cobranca = check(await db.from('cobrancas_whatsapp').insert({ cliente_nome: 'Transportadora sintética', cliente_telefone: phone, valor: 100, etapa: 1, status: 'enviada', origem: 'manual', data_envio: new Date().toISOString() }).select().single())
})
test.after(async () => {
 if(cotacao) { const qs=check(await db.from('frete_consultas').select('id').eq('cotacao_id',cotacao.id)); const ids=qs.map(q=>q.id); check(await db.from('frete_envios').delete().in('consulta_id',ids)); check(await db.from('frete_mensagens').delete().eq('cotacao_id',cotacao.id)); check(await db.from('frete_consultas').delete().eq('cotacao_id',cotacao.id)); check(await db.from('frete_cotacoes').delete().eq('id',cotacao.id)) }
 check(await db.from('whatsapp_mensagens').delete().in('evolution_id',eventIds))
 if(cobranca) check(await db.from('cobrancas_whatsapp').delete().eq('id',cobranca.id))
 if(supplier) check(await db.from('fornecedores').delete().eq('id',supplier.id))
 await limparInstanciasDeTeste(db); await pararAmbienteDeTeste(); await db._pool.end()
})
test('transportadora sem cotação aberta fica no histórico financeiro e não marca cobrança respondida', async () => {
 await processEvent(event(eventIds[0]))
 const m = check(await db.from('whatsapp_mensagens').select('*').eq('evolution_id',eventIds[0]).single())
 assert.equal(m.lead_id,null); assert.equal(m.mensagem,'Qual peso?')
 assert.equal(check(await db.from('cobrancas_whatsapp').select('status').eq('id',cobranca.id).single()).status,'enviada')
})
test('falha na classificação de frete preserva histórico e não altera cobrança', async () => {
 await db._pool.query('alter table public.frete_consultas rename to frete_consultas_indisponivel_teste')
 try { await processEvent(event(eventIds[1])) } finally { await db._pool.query('alter table public.frete_consultas_indisponivel_teste rename to frete_consultas') }
 assert.equal(check(await db.from('whatsapp_mensagens').select('mensagem').eq('evolution_id',eventIds[1]).single()).mensagem,'Qual peso?')
 assert.equal(check(await db.from('cobrancas_whatsapp').select('status').eq('id',cobranca.id).single()).status,'enviada')
})
test('cotação aberta intercepta resposta no histórico próprio sem entrar em cobrança', async () => {
 cotacao = check(await db.rpc('frete_criar_cotacao',{p_dados:{descricao:'Carga sintética'},p_ids:[supplier.id],p_actor:'test'}))
 check(await db.from('frete_consultas').update({status:'aguardando'}).eq('cotacao_id',cotacao.id))
 await processEvent(event(eventIds[2])); await processEvent(event(eventIds[2]))
 assert.equal(check(await db.from('frete_mensagens').select('*').eq('evolution_id',eventIds[2])).length,1)
 assert.equal(check(await db.from('whatsapp_mensagens').select('*').eq('evolution_id',eventIds[2])).length,0)
 assert.equal(check(await db.from('cobrancas_whatsapp').select('status').eq('id',cobranca.id).single()).status,'enviada')
})

test('erro no frete não impede resposta de cobrança de não-transportadora', async () => {
 check(await db.from('fornecedores').update({participa_cotacao_frete:false}).eq('id',supplier.id))
 check(await db.from('cobrancas_whatsapp').update({status:'enviada'}).eq('id',cobranca.id))
 await db._pool.query('alter table public.frete_consultas rename to frete_consultas_indisponivel_teste')
 const id='frete-devedor-fallback';eventIds.push(id)
 try { await processEvent(event(id)) } finally { await db._pool.query('alter table public.frete_consultas_indisponivel_teste rename to frete_consultas');check(await db.from('fornecedores').update({participa_cotacao_frete:true}).eq('id',supplier.id)) }
 assert.equal(check(await db.from('cobrancas_whatsapp').select('status').eq('id',cobranca.id).single()).status,'respondida')
})
