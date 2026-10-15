// Banco dedicado, sintético e loopback. Nunca lê .env ou configurações reais.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import express from 'express'
import jwt from 'jsonwebtoken'
const database = process.env.FRETE_TEST_DATABASE ?? 'vivenzza_fretes_test_v5'
assert.match(database, /^vivenzza_fretes_test(?:_[a-z0-9]+)*$/)
const port=process.env.FRETE_TEST_PORT??'5548'
assert.match(port,/^\d{4,5}$/)
const url = `postgres://postgres@127.0.0.1:${port}/${database}`
process.env.LOCAL_PG_URL = url
process.env.FRETE_MODULO_INSTALADO = 'false'
process.env.FRETE_ENVIO_ATIVO = 'false'
process.env.FRETE_NETVISION_LEITURA_DIRETA = 'false'
process.env.JWT_SECRET = 'synthetic-fretes-tests-only'
const { createLocalPgClient } = await import('../../src/lib/localdev/pgCompatClient.js')
const { createFretesRouter } = await import('../../src/routes/fretes.js')
const { auth } = await import('../../src/middleware/auth.js')
const {default:produtosRouter}=await import('../../src/routes/produtos.js')
const db = createLocalPgClient(url)
const sql = new pg.Client({ connectionString: url })
 let server, base, supplier, cotacao, logisticaDireta, falharDireta=false
const token = role => jwt.sign({ id: 'test-actor', role }, process.env.JWT_SECRET)
async function request(path, method = 'GET', body, role = 'financeiro') {
 const response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token(role)}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
 return { status: response.status, data: await response.json() }
}
const payload = () => ({ descricao: 'Embalagens sintéticas', valor_mercadoria: 1000, peso_kg: 20, volumes: [{ quantidade: 2, comprimento_cm: 50, largura_cm: 40, altura_cm: 30 }], retirada: { nome: 'Fábrica A teste', cnpj: '11111111000111', cep: '90000000', endereco: 'Rua sintética A' }, entrega: { nome: 'Fábrica B teste', cnpj: '22222222000122', cep: '91000000', endereco: 'Rua sintética B' }, pagador: { nome: 'Empresa teste', cnpj: '33333333000133' }, transportadora_ids: [supplier], max_prazo_dias: 3 })
test.before(async () => {
 await sql.connect()
 try{
 await sql.query(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if; if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if; if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if; end $$`)
 await sql.query(`create table if not exists public.fornecedores(id uuid primary key default gen_random_uuid(),cnpj text not null unique,razao_social text not null,nome_fantasia text,ie text,endereco jsonb,contatos jsonb,ativo boolean not null default true,origem text not null default 'manual',criado_por uuid,criado_em timestamptz not null default now(),atualizado_em timestamptz not null default now())`)
 if (!(await sql.query("select to_regclass('public.frete_cotacoes') present")).rows[0].present) await sql.query(await readFile(new URL('../../supabase/migrations/20261014140810_cotacoes_frete_fornecedores.sql', import.meta.url), 'utf8'))
 await sql.query(`create table if not exists clientes_erp(id uuid primary key default gen_random_uuid(),razao_social text,cnpj_cpf text,endereco jsonb)`)
 await sql.query(`create table if not exists pedidos(id uuid primary key default gen_random_uuid(),legacy_id text,sistema_origem text,status text,total numeric,peso_bruto numeric,qtde_volumes integer,cliente_erp_id uuid,cliente_nome_origem text,cliente_documento_origem text,sincronizado_em timestamptz,status_importacao_pendente boolean,erro_sincronizacao text,conflito_sincronizacao boolean,campos_com_override_local jsonb)`)
 await sql.query(await readFile(new URL('../../supabase/migrations/20261015155158_frete_logistica_pedido.sql',import.meta.url),'utf8'))
 await sql.query('create table if not exists pedido_itens(id uuid primary key default gen_random_uuid(),pedido_id uuid,produto_id uuid,quantidade numeric)')
 await sql.query('alter table pedido_itens add column if not exists produto_id uuid,add column if not exists quantidade numeric')
 await sql.query('create table if not exists produtos(id uuid primary key default gen_random_uuid(),legacy_id text,unidade text,logistica_fisica jsonb)')
 await sql.query('alter table produtos add column if not exists legacy_id text,add column if not exists unidade text,add column if not exists logistica_fisica jsonb')
 await sql.query(`create table if not exists automacoes_config(id integer primary key,multi_whatsapp boolean,global_daily_limit integer,global_hourly_limit integer);insert into automacoes_config values(1,true,1000,1000)on conflict(id)do update set global_daily_limit=1000,global_hourly_limit=1000;create table if not exists collection_dispatches(id uuid primary key,purpose text,origem text,criado_em timestamptz);create table if not exists collection_dispatch_attempts(id uuid primary key,dispatch_id uuid,whatsapp_instance_id uuid,criado_em timestamptz);create table if not exists whatsapp_instances(id uuid primary key default gen_random_uuid(),instance_name text unique);alter table whatsapp_instances add column if not exists enabled boolean default true,add column if not exists daily_limit integer,add column if not exists hourly_limit integer;create table if not exists cobrancas_whatsapp(id uuid primary key,data_envio timestamptz);`)
 if(!(await sql.query("select to_regclass('public.frete_orcamento_controle') as t")).rows[0].t)await sql.query(await readFile(new URL('../../supabase/migrations/20261015194843_frete_concorrencia_orcamento.sql',import.meta.url),'utf8'))
 // Atualiza somente funcoes deste schema sintetico para repetir o ensaio apos ajustes.
 const novaMigration=await readFile(new URL('../../supabase/migrations/20261015194843_frete_concorrencia_orcamento.sql',import.meta.url),'utf8')
 for(const fn of novaMigration.match(/create (?:or replace )?function[\s\S]*?\$\$;/g)??[])await sql.query(fn.replace(/^create (?:or replace )?function/,'create or replace function'))
 for(const nome of ['frete_consulta_versao','frete_orcamento_insercao'])if(!(await sql.query('select 1 from pg_trigger where tgname=$1',[nome])).rows.length)await sql.query(novaMigration.match(new RegExp('create trigger '+nome+'[^;]+;'))[0])
 await sql.query("insert into whatsapp_instances(instance_name)values('vivenzza-financeiro')on conflict do nothing;select frete_ativar_orcamento();")
 const { rows } = await sql.query(`insert into fornecedores(cnpj,razao_social,participa_cotacao_frete,telefone_cotacao_frete,cotacao_frete_consentimento) values($1,'Transportadora teste',true,'5551999990001',true) returning id`, [`TEST-${Date.now()}`])
 supplier = rows[0].id
 const app = express(); app.use(express.json()); app.use('/api/fretes', auth, createFretesRouter(db,{loadLogistica:async()=>{if(falharDireta)throw Error('teste indisponível');return logisticaDireta}}))
 app.use('/api/produtos',auth,produtosRouter)
 server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}/api/fretes`
 }catch(e){await sql.query('rollback');console.error('SETUP LOCAL',e.message);throw e}
})
test.after(async () => {
 if (supplier) {
  await sql.query('delete from frete_envios where consulta_id in(select id from frete_consultas where fornecedor_id=$1)', [supplier])
  await sql.query('delete from frete_mensagens where consulta_id in(select id from frete_consultas where fornecedor_id=$1)', [supplier])
  const ids = (await sql.query('delete from frete_consultas where fornecedor_id=$1 returning cotacao_id', [supplier])).rows.map(r => r.cotacao_id)
  await sql.query('delete from frete_cotacoes where id=any($1::uuid[])', [ids]); await sql.query('delete from fornecedores where id=$1', [supplier])
 }
 await sql.query('update frete_orcamento_controle set ativo=false where id=1')
 if (server) await new Promise(r => server.close(r)); await db._pool.end(); await sql.end()
})
test('API restringe vendedores e exige autenticação antes de ler fornecedor', async () => {
 assert.equal((await request('/transportadoras', 'GET', undefined, 'vendedor')).status, 403)
 assert.equal((await fetch(`${base}/transportadoras`)).status, 401)
 assert.equal((await request('/transportadoras')).status, 200)
})
test('cotação mantém FK fornecedor e rejeita contato já ocupado sem deixar cotação parcial', async () => {
 const result = await request('/', 'POST', payload()); assert.equal(result.status, 201); cotacao = result.data
 assert.ok(cotacao.id)
 const row = (await sql.query('select fornecedor_id,telefone from frete_consultas where cotacao_id=$1', [cotacao.id])).rows[0]
 assert.equal(row.fornecedor_id, supplier)
 assert.equal((await request('/', 'POST', payload())).status, 409)
 const original = '5551999990001'
 const variante = original.slice(0, 4) + original.slice(5)
 const outro = (await sql.query(`insert into fornecedores(cnpj,razao_social,participa_cotacao_frete,telefone_cotacao_frete) values($1,'Outra filial teste',true,$2) returning id`, [`VAR-${Date.now()}`, variante])).rows[0].id
 try { assert.equal((await request('/', 'POST', { ...payload(), transportadora_ids: [outro] })).status, 409) } finally { await sql.query('delete from fornecedores where id=$1', [outro]) }
 assert.equal((await sql.query('select count(*)::int n from frete_cotacoes where criado_por=$1', ['test-actor'])).rows[0].n, 1)
})
test('fila desligada não envia, dupla solicitação é idempotente e claim concorrente é único', async () => {
 assert.equal((await request(`/${cotacao.id}/enviar`, 'POST', {})).status, 409)
 const enqueue = () => db.rpc('frete_enfileirar_cotacao', { p_cotacao_id: cotacao.id, p_texto: 'Mensagem sintética', p_actor: 'test' })
 const responses = await Promise.all([enqueue(), enqueue()]); assert.ok(responses.every(r => !r.error)); assert.equal(responses.reduce((s, r) => s + r.data, 0), 1)
 const e = (await sql.query('select id from frete_envios where consulta_id in(select id from frete_consultas where cotacao_id=$1)', [cotacao.id])).rows[0]
 const claim = () => db.rpc('frete_claim_envio', { p_envio_id: e.id })
 const claims = await Promise.all([claim(), claim()]); assert.ok(claims.every(r => !r.error)); assert.equal(claims.filter(r => r.data).length, 1)
 assert.equal((await sql.query('select status,attempted_at from frete_envios where id=$1', [e.id])).rows[0].status, 'enviando')
})
test('tentativas de frete consomem teto global e por instância mesmo com envios pausados', async () => {
 await sql.query(`create table if not exists automacoes_config(id integer primary key,multi_whatsapp boolean,global_daily_limit integer,global_hourly_limit integer); insert into automacoes_config values(1,true,1,1) on conflict(id) do update set multi_whatsapp=true,global_daily_limit=1,global_hourly_limit=1; create table if not exists collection_dispatches(id uuid primary key,purpose text,origem text,criado_em timestamptz); create table if not exists collection_dispatch_attempts(id uuid primary key,dispatch_id uuid,whatsapp_instance_id uuid,criado_em timestamptz); create table if not exists whatsapp_instances(id uuid primary key default gen_random_uuid(),instance_name text unique); insert into whatsapp_instances(instance_name) values('vivenzza-financeiro') on conflict do nothing`)
 process.env.FRETE_MODULO_INSTALADO = 'true'
 try {
  const { contarTentativasReaisDesde } = await import('../../src/lib/collection/providerAttemptCounter.js')
  const { verificarLimiteGlobalEnvio } = await import('../../src/lib/collection/globalSendLimit.js')
  const { contarEnviosReaisHojePorInstancia } = await import('../../src/lib/collection/whatsappInstances.js')
  assert.equal(await contarTentativasReaisDesde({ desde: '2000-01-01T00:00:00Z' }), 1)
  assert.equal((await verificarLimiteGlobalEnvio()).permitido, false)
  const instance = (await sql.query("select id from whatsapp_instances where instance_name='vivenzza-financeiro'")).rows[0]
  assert.equal((await contarEnviosReaisHojePorInstancia()).get(instance.id), 1)
 } finally { process.env.FRETE_MODULO_INSTALADO = 'false';await sql.query('update automacoes_config set global_daily_limit=1000,global_hourly_limit=1000 where id=1') }
})
test('proposta conferida entra no ranking, pausa assistente e consulta alheia é recusada', async () => {
 const q = (await sql.query('select id from frete_consultas where cotacao_id=$1', [cotacao.id])).rows[0]
 const body = { valor_total: 120, prazo_dias: 10, validade: '2030-01-01T00:00:00Z', completa: true }
 const pause = await request(`/${cotacao.id}/consultas/${q.id}`, 'PATCH', { ia_pausada: true }); assert.equal(pause.status, 200); assert.equal(pause.data.valor_total, null); assert.equal(pause.data.ia_pausada, true)
 body.versao=pause.data.updated_at
 assert.equal((await request(`/${cotacao.id}/consultas/00000000-0000-4000-8000-000000000001`, 'PATCH', body)).status, 409)
 const save = await request(`/${cotacao.id}/consultas/${q.id}`, 'PATCH', body); assert.equal(save.status, 200); assert.equal(save.data.ia_pausada, true)
 assert.equal((await request(`/${cotacao.id}/consultas/${q.id}`, 'PATCH', body)).status,409)
 const detail = await request(`/${cotacao.id}`); assert.equal(detail.data.comparativo.menor_valor.valor_total, 120); assert.equal(detail.data.comparativo.melhor_custo_beneficio, null)
 assert.equal((await request(`/${cotacao.id}/encerrar`, 'POST', {})).status, 200)
 assert.equal((await request(`/${cotacao.id}/consultas/${q.id}`, 'PATCH', body)).status, 409)
})
test('fila Evolution, resposta limitada, dedup e encerramento durante provider funcionam com banco real', async () => {
 const { runFreteQueue } = await import('../../src/lib/fretes/worker.js')
 const { handleFreteInbound } = await import('../../src/lib/fretes/inbound.js')
 await sql.query("alter table whatsapp_instances add column if not exists enabled boolean default true, add column if not exists connection_status text default 'connected', add column if not exists health_status text default 'healthy', add column if not exists cooldown_until timestamptz, add column if not exists daily_limit integer default 30")
 const result = await request('/', 'POST', payload()); assert.equal(result.status, 201)
 const c = result.data
 const q = (await sql.query('select * from frete_consultas where cotacao_id=$1', [c.id])).rows[0]
 await db.rpc('frete_enfileirar_cotacao', { p_cotacao_id: c.id, p_texto: 'Solicitação sintética', p_actor: 'test' })
 await sql.query("update frete_envios set attempted_at=now()-interval '5 minutes' where attempted_at is not null")
 let sent = 0
 const options = { db, recordSuccess: async () => {}, recordFailure: async () => {}, installed: true, enabled: true, assistantEnabled: true, globalLimit: async () => ({ permitido: true }), dnc: async () => ({ blocked: false }), instanceCounts: async () => new Map() }
 const first = await runFreteQueue({ ...options, send: async () => { sent++; return { ok: true, providerMessageId: `synthetic-first-${c.id}` } } })
 assert.equal(first.status, 'enviado'); assert.equal(sent, 1)
 const opts = { db, installed: true, assistantEnabled: true }
 const event = { instanceName: 'vivenzza-financeiro', telefone: q.telefone, texto: 'Qual peso e cubagem?', evolutionId: `synthetic-in-${c.id}`, fromMe: false }
 assert.equal(await handleFreteInbound(event, opts), true); assert.equal(await handleFreteInbound(event, opts), true)
 const reply = (await sql.query('select mensagem_id,texto from frete_envios where consulta_id=$1 and mensagem_id is not null', [q.id])).rows
 assert.equal(reply.length, 1); assert.ok(reply[0].mensagem_id); assert.match(reply[0].texto,/20 kg/); assert.match(reply[0].texto,/0.1200 m³/)
 await sql.query("update frete_envios set attempted_at=now()-interval '5 minutes' where attempted_at is not null")
 const second = await runFreteQueue({ ...options, send: async () => { sent++; await db.rpc('frete_encerrar_cotacao', { p_cotacao_id: c.id, p_actor: 'test' }); return { ok: true, providerMessageId: `synthetic-second-${c.id}` } } })
 assert.equal(second.status, 'enviado'); assert.equal(sent, 2)
 assert.equal((await sql.query('select status from frete_consultas where id=$1', [q.id])).rows[0].status, 'encerrada')
 assert.deepEqual(await handleFreteInbound({ ...event, evolutionId: 'sem-cotacao' }, opts), { semCotacao: true })
})
test('respostas simultâneas têm limite transacional de seis e pausam para revisão', async () => {
 const c = (await request('/', 'POST', payload())).data
 const q = (await sql.query('select * from frete_consultas where cotacao_id=$1', [c.id])).rows[0]
 const messages = []
 for (let i=0;i<7;i++) messages.push((await sql.query("insert into frete_mensagens(cotacao_id,consulta_id,direcao,texto,evolution_id) values($1,$2,'entrada','Qual peso?',$3) returning id", [c.id,q.id,`bounded-${c.id}-${i}`])).rows[0].id)
 const replies = await Promise.all(messages.map(m => db.rpc('frete_enfileirar_resposta', { p_consulta_id: q.id, p_mensagem_id: m, p_texto: 'Peso bruto: 20 kg' })))
 assert.ok(replies.every(r => !r.error)); assert.equal(replies.filter(r => r.data).length, 6)
 assert.equal((await sql.query('select count(*)::int n from frete_envios where consulta_id=$1 and mensagem_id is not null', [q.id])).rows[0].n, 6)
 assert.equal((await sql.query('select ia_pausada from frete_consultas where id=$1', [q.id])).rows[0].ia_pausada, true)
 await db.rpc('frete_encerrar_cotacao', { p_cotacao_id: c.id, p_actor: 'test' })
})
test('tabelas e RPCs não ficam disponíveis para anon/authenticated', async () => {
 const privileges = (await sql.query(`select has_table_privilege('anon','public.frete_cotacoes','SELECT') a,has_table_privilege('authenticated','public.frete_envios','INSERT') b,has_function_privilege('anon','public.frete_claim_envio(uuid)','EXECUTE') c,has_table_privilege('anon','public.frete_reservas_legado','SELECT') d,has_function_privilege('authenticated','public.frete_ativar_orcamento(text)','EXECUTE') e`)).rows[0]
 assert.deepEqual(privileges, { a: false, b: false, c: false,d:false,e:false })
 assert.equal((await sql.query("select count(*)::int n from pg_class where relname in('frete_cotacoes','frete_consultas','frete_mensagens','frete_envios') and relrowsecurity")).rows[0].n, 4)
})

test('novo fornecedor salva WhatsApp e participação na mesma criação, valida CNPJ/telefone e impede financeiro',async()=>{
 const body={cnpj:'11222333000181',razao_social:'Fornecedor sintético com telefone',telefone_cotacao_frete:'(51) 99999-0333',participa_cotacao_frete:true,cotacao_frete_consentimento:false}
 assert.equal((await request('/transportadoras','POST',body,'financeiro')).status,403)
 assert.equal((await request('/transportadoras','POST',{...body,telefone_cotacao_frete:''},'admin')).status,400)
 assert.equal((await request('/transportadoras','POST',{...body,cnpj:'123'},'admin')).status,400)
 const masked=(await sql.query(`insert into fornecedores(cnpj,razao_social)values('11.222.333/0001-81','Fornecedor legado sintético')returning id`)).rows[0].id
 try{assert.equal((await request('/transportadoras','POST',body,'admin')).status,409);assert.ok((await request('/transportadoras?busca=11222333000181')).data.data.some(s=>s.id===masked))}finally{await sql.query('delete from fornecedores where id=$1',[masked])}
 const simultaneos=await Promise.all([request('/transportadoras','POST',body,'admin'),request('/transportadoras','POST',body,'admin')]);assert.deepEqual(simultaneos.map(r=>r.status).sort(),[201,409]);assert.match(simultaneos.find(r=>r.status===409).data.erro,/Fornecedor já cadastrado/);const r=simultaneos.find(r=>r.status===201);const id=r.data.id
 try {assert.equal(r.data.telefone_cotacao_frete,'5551999990333');assert.equal(r.data.cotacao_frete_consentimento,false);assert.equal(r.data.participa_cotacao_frete,true);assert.equal((await request('/transportadoras','POST',body,'admin')).status,409)}finally{await sql.query('delete from fornecedores where id=$1',[id])}
})
test('pedido por número preenche cliente/emitente/logística sem escrever pedido e exige conferência ao salvar',async()=>{
 const cliente=(await sql.query(`insert into clientes_erp(razao_social,cnpj_cpf,endereco)values('Cliente sintético','12345678901','{"cep":"90000000","logradouro":"Rua teste","numero":"1","cidade":"Cidade","uf":"RS"}')returning id`)).rows[0].id
 const snapshot={consultado_em:new Date().toISOString(),itens:[{Sequencia:1,CodigoItem:'PROD-FISICO-TESTE',Quantidade:2,Unidade:'UN',UnidadeManipulacao:'UN',PesoBruto:3,UnidadePeso:0,QtdeVolumeCubico:0.04,StatusMedidasCubicas:0}]}
 const pedido=(await sql.query(`insert into pedidos(legacy_id,sistema_origem,status,total,peso_bruto,qtde_volumes,cliente_erp_id,frete_logistica)values('001-987654321','legado','confirmado',500,10,2,$1,$2)returning id`,[cliente,snapshot])).rows[0].id
 let duplicado,criada
 try {
  assert.equal((await request('/pedidos/987654321','GET',undefined,'vendedor')).status,403)
  assert.equal((await request('/pedidos/123abc')).status,400);assert.equal((await request('/pedidos/0')).status,400)
  const r=await request('/pedidos/987654321');assert.equal(r.status,200);const d=r.data.dados
  assert.equal(d.entrega.nome,'Cliente sintético');assert.equal(d.entrega.cnpj,'12345678901');assert.equal(d.peso_kg,10);assert.equal(d.cubagem_m3,'');assert.equal(r.data.sugestoes_logistica.cubagem_produtos,0.08);assert.equal(d.quantidade_volumes,2);assert.ok(d.retirada.cnpj);assert.equal(d.pagador.cnpj,d.retirada.cnpj);assert.equal(d.dados_importados_conferidos,false)
  process.env.FRETE_NETVISION_LEITURA_DIRETA='true';logisticaDireta={...snapshot,itens:[{...snapshot.itens[0],QtdeVolumeCubico:0.05}]}
  try{assert.equal((await request('/pedidos/987654321')).data.sugestoes_logistica.cubagem_produtos,0.1);falharDireta=true;const fallback=await request('/pedidos/987654321');assert.equal(fallback.data.sugestoes_logistica.cubagem_produtos,0.08);assert.ok(fallback.data.avisos.some(a=>a.includes('indisponível')))}finally{process.env.FRETE_NETVISION_LEITURA_DIRETA='false';falharDireta=false}
  assert.equal((await sql.query('select frete_logistica from pedidos where id=$1',[pedido])).rows[0].frete_logistica.itens[0].QtdeVolumeCubico,0.04)
  assert.equal((await request('/','POST',{...d,transportadora_ids:[supplier]})).status,400)
  const saved=await request('/','POST',{...d,cubagem_m3:0.08,dados_importados_conferidos:true,transportadora_ids:[supplier]});assert.equal(saved.status,201);criada=saved.data.id
  const row=(await sql.query('select dados from frete_cotacoes where id=$1',[criada])).rows[0].dados;assert.equal(row.pedido_origem.id,pedido);assert.equal(row.conferido_por,'test-actor');assert.ok(row.conferido_em);assert.deepEqual(row.volumes,[])
  const prod=(await sql.query(`insert into produtos(legacy_id,unidade,logistica_fisica)values('PROD-FISICO-TESTE','UN',$1)returning id`,[{origem:'netvision',UnidadeCadastro:'UNID',PesoBruto:2,QtdeVolumeCubico:0.02,unidades:{peso:'kg',cubagem:'m3'}}])).rows[0].id
  const item=(await sql.query('insert into pedido_itens(pedido_id,produto_id,quantidade)values($1,$2,3)returning id',[pedido,prod])).rows[0].id
  try{
   const atual=await request('/pedidos/987654321');assert.equal(atual.status,200);assert.equal(atual.data.dados.cubagem_m3,0.06);assert.equal(atual.data.dados.peso_kg,10)
   await sql.query('alter table produtos rename column logistica_fisica to logistica_fisica_off_teste')
   try{const fallback=await request('/pedidos/987654321');assert.equal(fallback.status,200);assert.ok(fallback.data.avisos.some(a=>a.includes('cadastro físico atual')))}finally{await sql.query('alter table produtos rename column logistica_fisica_off_teste to logistica_fisica')}
   const url=base.replace('/api/fretes','')+`/api/produtos/${prod}`
   const put=await fetch(url,{method:'PUT',headers:{Authorization:`Bearer ${token('admin')}`,'Content-Type':'application/json'},body:JSON.stringify({logistica_fisica:{origem:'manual',PesoBruto:999}})})
   assert.equal(put.status,400,await put.text());assert.equal((await sql.query('select logistica_fisica from produtos where id=$1',[prod])).rows[0].logistica_fisica.PesoBruto,2)
  }finally{await sql.query('delete from pedido_itens where id=$1',[item]);await sql.query('delete from produtos where id=$1',[prod])}
  duplicado=(await sql.query(`insert into pedidos(legacy_id,sistema_origem,status,total)values('002-987654321','legado','confirmado',500)returning id`)).rows[0].id
  assert.equal((await request('/pedidos/987654321')).status,409);assert.equal((await request('/pedidos/987654321?filial=001')).status,200)
  await sql.query('update pedidos set status_importacao_pendente=true where id=$1',[pedido]);assert.equal((await request('/','POST',{...d,cubagem_m3:0.08,dados_importados_conferidos:true,transportadora_ids:[supplier]})).status,409);
  await sql.query("update pedidos set status='cancelado' where id=$1",[pedido]);assert.equal((await request('/pedidos/987654321?filial=001')).status,409)
 }finally {
  if(criada){await sql.query('delete from frete_consultas where cotacao_id=$1',[criada]);await sql.query('delete from frete_cotacoes where id=$1',[criada])}
  await sql.query('delete from pedidos where id=any($1::uuid[])',[[pedido,...(duplicado?[duplicado]:[])]]);await sql.query('delete from clientes_erp where id=$1',[cliente])
 }
})

test('opt-out com tela antiga nao pode restaurar consentimento',async()=>{
 const antigo=(await sql.query('select * from fornecedores where id=$1',[supplier])).rows[0]
 await sql.query("update fornecedores set cotacao_frete_consentimento=false,cotacao_frete_atualizada_por='opt_out_inbound' where id=$1",[supplier])
 const body={participa_cotacao_frete:true,telefone_cotacao_frete:antigo.telefone_cotacao_frete,cotacao_frete_consentimento:true,versao:antigo.cotacao_frete_atualizada_em}
 assert.equal((await request(`/transportadoras/${supplier}`,'PATCH',body)).status,409)
 assert.equal((await sql.query('select cotacao_frete_consentimento from fornecedores where id=$1',[supplier])).rows[0].cotacao_frete_consentimento,false)
})

test('reserva atomica disputa a ultima vaga entre frete, v2 e legado',async()=>{
 const q=(await sql.query('select id from frete_consultas where fornecedor_id=$1 limit 1',[supplier])).rows[0].id
 const instancia=(await sql.query("select id from whatsapp_instances where instance_name='vivenzza-financeiro'")).rows[0].id
 for(const porInstancia of [false,true]){
  const d=(await sql.query("insert into collection_dispatches(id,purpose,origem,criado_em)values(gen_random_uuid(),'collection','manual',now())returning id")).rows[0].id
  const e=(await sql.query("insert into frete_envios(consulta_id,telefone,texto,idempotency_key)values($1,'5551999990001','teste concorrente',gen_random_uuid()::text)returning id",[q])).rows[0].id
  let ids=[]
  try{
   const n=Number((await sql.query("select frete_contar_orcamento(date_trunc('hour',now()),$1) as n",[porInstancia?'vivenzza-financeiro':null])).rows[0].n)
   await sql.query('update automacoes_config set global_daily_limit=1000,global_hourly_limit=$1 where id=1',[porInstancia?1000:n+1])
   await sql.query('update whatsapp_instances set hourly_limit=$1 where id=$2',[porInstancia?n+1:null,instancia])
   const tentativas=await Promise.allSettled([
    db._pool.query('update frete_envios set attempted_at=clock_timestamp() where id=$1 returning id',[e]),
    db._pool.query('insert into collection_dispatch_attempts(id,dispatch_id,whatsapp_instance_id,criado_em)values(gen_random_uuid(),$1,$2,clock_timestamp())returning id',[d,instancia]),
    db._pool.query("select frete_reservar_legado('vivenzza-financeiro') as id")
   ])
   assert.equal(tentativas.filter(r=>r.status==='fulfilled').length,1)
   for(const r of tentativas.filter(r=>r.status==='rejected'))assert.match(r.reason.message,/limite_.*reserva/)
   if(tentativas[2].status==='fulfilled')ids.push(tentativas[2].value.rows[0].id)
  }finally{
   await sql.query('update automacoes_config set global_daily_limit=1000,global_hourly_limit=1000 where id=1')
   await sql.query('update whatsapp_instances set hourly_limit=null where id=$1',[instancia])
   await sql.query('delete from frete_reservas_legado where id=any($1::uuid[])',[ids]);await sql.query('delete from frete_envios where id=$1',[e]);await sql.query('delete from collection_dispatch_attempts where dispatch_id=$1',[d]);await sql.query('delete from collection_dispatches where id=$1',[d])
  }
 }
})

test('controle inativo preserva legado antes da ativacao e contagem nao reinicia ao trocar motor',async()=>{
 const controle=(await sql.query('select to_jsonb(c) as c from frete_orcamento_controle c')).rows[0].c
 const fixture=(await sql.query('insert into cobrancas_whatsapp(id,data_envio)values(gen_random_uuid(),now())returning id')).rows[0].id
 let reserva
 try{
  await sql.query('update frete_orcamento_controle set ativo=false,ativado_em=null,contar_historico_legado=false where id=1;update automacoes_config set multi_whatsapp=false where id=1')
  const n=Number((await sql.query("select frete_contar_orcamento(date_trunc('hour',now())) as n")).rows[0].n)
  assert.ok(n>=1);assert.equal((await sql.query("select frete_reservar_legado('vivenzza-financeiro') as r")).rows[0].r,null)
  await sql.query('select frete_ativar_orcamento()')
  const inicio=Number((await sql.query("select frete_contar_orcamento(date_trunc('hour',now())) as n")).rows[0].n)
  reserva=(await sql.query("select frete_reservar_legado('vivenzza-financeiro') as r")).rows[0].r
  await sql.query('update automacoes_config set multi_whatsapp=true where id=1')
  assert.equal(Number((await sql.query("select frete_contar_orcamento(date_trunc('hour',now())) as n")).rows[0].n),inicio+1)
 }finally{
  await sql.query('delete from frete_reservas_legado where id=$1',[reserva]);await sql.query('delete from cobrancas_whatsapp where id=$1',[fixture]);await sql.query('update automacoes_config set multi_whatsapp=true where id=1')
  await sql.query('update frete_orcamento_controle set ativo=$1,ativado_em=$2,contar_historico_legado=$3 where id=1',[controle.ativo,controle.ativado_em,controle.contar_historico_legado])
 }
})
