// Banco de baseline sintético exclusivo. Sem dotenv e sem chamadas ao legado real.
import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
const port=process.env.FRETE_TEST_PORT??'5548'
assert.match(port,/^\d{4,5}$/)
process.env.LOCAL_PG_URL=`postgres://postgres@127.0.0.1:${port}/vivenzza_fretes_test_v5`
const sql=new pg.Client({connectionString:process.env.LOCAL_PG_URL})
const {supabase}=await import('../../src/lib/supabase-admin.server.js')
const {processarPedido}=await import('../../src/jobs/sync-pedidos-legado.js')
const {sincronizarLogisticaProdutos}=await import('../../src/jobs/sync-logistica-produtos.js')
const legacy='999-987654322'
const row={CodigoFilial:'999',NumeroPedido:987654322,CodigoEmitente:'',Representante:'',StatusPedido:1,Cancelado:0,PedidoConfirmado:1,Valor:100,ValorDesconto:0,ValorFrete:0,PesoBruto:5,QtdeVolumes:1,DataEmissao:'2026-01-01',DataAtualizacao:'2026-01-01T12:00:00Z'}
const contadores=()=>({total_atualizado:0,total_criado:0,total_ignorado:0,total_com_erro:0})
const args={row,legacyId:legacy,mapaClientes:new Map(),mapaProdutos:new Map(),mapaVendedores:new Map(),logisticaAtiva:true}
test.before(async()=>{await sql.connect();await sql.query(`alter table pedidos add column if not exists frete_logistica jsonb, add column if not exists atualizado_localmente_em timestamptz, add column if not exists cliente_externo_id text, add column if not exists precisa_vinculo_cliente boolean, add column if not exists vendedor_id uuid, add column if not exists vendedor_nome text, add column if not exists status_origem text, add column if not exists desconto numeric, add column if not exists valor_frete numeric, add column if not exists condicao_pagamento text, add column if not exists observacoes text, add column if not exists criado_em timestamptz, add column if not exists atualizado_no_origem_em timestamptz`);await sql.query('create table if not exists pedido_itens(id uuid primary key default gen_random_uuid(),pedido_id uuid)')})
test.after(async()=>{try{await sql.query("delete from produtos where legacy_id like 'LOGISTICA-TEST-%'");await sql.query('delete from pedido_itens where pedido_id in(select id from pedidos where legacy_id=$1)',[legacy]);await sql.query('delete from pedidos where legacy_id=$1',[legacy]);}finally{await sql.end();await supabase._pool.end()}})
test('falha de logística não bloqueia criação/atualização comercial nem apaga snapshot anterior',async()=>{
 let leituras=0
 const e01Client={query:async q=>{if(typeof q==='object'){leituras++;throw Error('logística sintética indisponível')}return {rows:[]}}}
 const counts=contadores();await processarPedido({...args,e01Client,contadores:counts});assert.equal(counts.total_criado,1);assert.equal(leituras,1)
 await sql.query('update pedidos set frete_logistica=$1 where legacy_id=$2',[{versao:'snapshot-anterior'},legacy])
 await processarPedido({...args,row:{...row,Valor:200},e01Client,contadores:counts})
 const saved=(await sql.query('select total,frete_logistica from pedidos where legacy_id=$1',[legacy])).rows[0]
 assert.equal(Number(saved.total),200);assert.equal(saved.frete_logistica.versao,'snapshot-anterior');assert.equal(counts.total_atualizado,1)
 await processarPedido({...args,e01Client:{query:async()=>({rows:[]})},contadores:counts})
 assert.equal((await sql.query('select frete_logistica from pedidos where legacy_id=$1',[legacy])).rows[0].frete_logistica.versao,'snapshot-anterior')
})
test('override local em itens impede leitura de logística do legado',async()=>{
 await sql.query("update pedidos set campos_com_override_local='[\"itens\"]',atualizado_localmente_em=now() where legacy_id=$1",[legacy])
 let calls=0;const e01Client={query:async()=>{calls++;throw Error('não consultar')}}
 await processarPedido({...args,e01Client,contadores:contadores()});assert.equal(calls,0)
})

test('cache físico atualiza só logística, preserva preço e cadastro manual e rejeita corrida de edição',async()=>{
 await sql.query('create table if not exists produtos(id uuid primary key default gen_random_uuid(),legacy_id text,unidade text,logistica_fisica jsonb)')
 await sql.query('alter table produtos add column if not exists logistica_fisica jsonb,add column if not exists preco_b2c numeric')
 const rows=(await sql.query(`insert into produtos(legacy_id,unidade,preco_b2c,logistica_fisica)values('LOGISTICA-TEST-A','UN',55,null),('LOGISTICA-TEST-B','UN',66,'{"origem":"manual","PesoBruto":99}')returning id,legacy_id`)).rows
 const dados=rows.map((r,i)=>({CodigoItem:r.legacy_id,UnidadeCadastro:'UNID',PesoBruto:2,UnidadePeso:0,QtdeVolumeCubico:0.003,StatusMedidasCubicas:0}))
 const result=await sincronizarLogisticaProdutos({e01Client:{query:async()=>({rows:dados})},db:supabase,peso:'kg',cubagem:'m3'})
 assert.equal(result.atualizados,1);assert.equal(result.preservados,1)
 const igual=await sincronizarLogisticaProdutos({e01Client:{query:async()=>({rows:dados})},db:supabase,peso:' KG ',cubagem:' M3 '});assert.equal(igual.atualizados,0);assert.equal(igual.sem_alteracao,1)
 let state=(await sql.query("select * from produtos where legacy_id like 'LOGISTICA-TEST-%' order by legacy_id")).rows
 assert.equal(Number(state[0].preco_b2c),55);assert.equal(state[0].logistica_fisica.PesoBruto,2);assert.equal(state[1].logistica_fisica.PesoBruto,99)
 // Intervenção humana entre leitura do cache e UPDATE: comparação da versão impede sobrescrever.
 const from=supabase.from.bind(supabase);let edited=false
 const db={from(table){const q=from(table);const update=q.update.bind(q);q.update=v=>{const eq=q.eq.bind(q);q.eq=(field,value)=>{const result=eq(field,value);if(field==='id'&&!edited){edited=true;const then=q.then.bind(q);q.then=(resolve,reject)=>sql.query(`update produtos set logistica_fisica='{"origem":"manual","PesoBruto":77}' where id=$1`,[value]).then(()=>then(resolve,reject));}return result};return update(v)};return q}}
 await sincronizarLogisticaProdutos({e01Client:{query:async()=>({rows:[{...dados[0],PesoBruto:3}]})},db,peso:'kg',cubagem:'m3'})
 state=(await sql.query('select logistica_fisica from produtos where id=$1',[rows[0].id])).rows
 assert.equal(state[0].logistica_fisica.PesoBruto,77)
})

test('configuração global não converte automaticamente códigos de peso divergentes',async()=>{
 const rows=(await sql.query(`insert into produtos(legacy_id,unidade)values('LOGISTICA-TEST-C','UN'),('LOGISTICA-TEST-D','UN')returning id,legacy_id`)).rows
 const dados=rows.map((r,i)=>({CodigoItem:r.legacy_id,UnidadeCadastro:'UNID',PesoBruto:2,UnidadePeso:i,QtdeVolumeCubico:0.003,StatusMedidasCubicas:0}))
 await sincronizarLogisticaProdutos({e01Client:{query:async()=>({rows:dados})},db:supabase,peso:'kg',cubagem:'m3'})
 const itens=(await sql.query('select logistica_fisica from produtos where id=any($1::uuid[])',[rows.map(r=>r.id)])).rows
 assert.ok(itens.every(i=>i.logistica_fisica.unidades.peso===null));assert.ok(itens.every(i=>i.logistica_fisica.unidades.cubagem==='m3'))
})
