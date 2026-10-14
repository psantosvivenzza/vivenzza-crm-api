// Explicit disposable local cluster. Never reads production configuration.
import pg from 'pg'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const db = new pg.Client({ host: '127.0.0.1', port: 55936, database: 'postgres', user: 'postgres', connectionTimeoutMillis: 3000, statement_timeout: 5000 })
const id = () => randomUUID()
const admin=id(), seller=id(), other=id(), lead=id(), client=id(), request=id()
async function rejects(code, sql, args) {
  await db.query('SAVEPOINT expected_failure')
  try { await assert.rejects(db.query(sql,args), e => e.code === code) }
  finally { await db.query('ROLLBACK TO SAVEPOINT expected_failure') }
}
try {
  await db.connect()
  await db.query('BEGIN')
  // Refuse even this local target if it is no longer an empty test database.
  assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n,0)
  await db.query(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE usuarios(id uuid PRIMARY KEY,role text,ativo boolean,disponivel_como_vendedor boolean);
    CREATE TABLE clientes_erp(id uuid PRIMARY KEY,legacy_id text,vendedor_responsavel_usuario_id uuid,vendedor_atribuicao_manual boolean);
    CREATE TABLE leads(id uuid PRIMARY KEY,responsavel_id uuid,cliente_erp_id text,updated_at timestamptz);
    CREATE TABLE tarefas(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid,titulo text,descricao text,prazo timestamptz,tipo text,status text,responsavel_id uuid,origem text,criado_em timestamptz DEFAULT now());
    CREATE TABLE whatsapp_mensagens(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),lead_id uuid,direcao text,created_at timestamptz);
    CREATE TABLE clientes_vendedor_historico(cliente_erp_id uuid,vendedor_anterior_id uuid,vendedor_novo_id uuid,usuario_alterou_id uuid,motivo text,origem text);`)
  await db.query(await readFile(new URL('../../../supabase/migrations/20261013172830_whatsapp_retornos_e_transferencia.sql',import.meta.url),'utf8'))
  for(const [uid,role] of [[admin,'admin'],[seller,'vendedor'],[other,'vendedor']]) await db.query('INSERT INTO usuarios VALUES($1,$2,true,true)',[uid,role])
  await db.query('INSERT INTO clientes_erp VALUES($1,$2,$3,false)',[client,'SYNTHETIC-INBOX',seller])
  await db.query('INSERT INTO leads VALUES($1,$2,$3,now())',[lead,seller,'SYNTHETIC-INBOX'])
  const due=new Date(Date.now()+86400000).toISOString()
  const schedule='SELECT agendar_retorno_whatsapp($1,$2,$3,$4,$5,$6,$7) AS result'
  const args=[request,lead,admin,seller,due,'Avaliar catálogo','whatsapp']
  const first=(await db.query(schedule,args)).rows[0].result
  assert.equal((await db.query(schedule,args)).rows[0].result.id,first.id)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tarefas')).rows[0].n,1)
  console.log('PASS: retry idempotente cria uma única tarefa atribuída à vendedora')
  await rejects('42501',schedule,[id(),lead,other,other,due,'Avaliar catálogo','whatsapp'])
  await rejects('23505',schedule,[id(),...args.slice(1)])
  console.log('PASS: outra carteira e segundo retorno ativo recusados')
  await db.query("INSERT INTO whatsapp_mensagens(lead_id,direcao,created_at) VALUES($1,'entrada',now()-interval '1 day')",[lead])
  assert.equal((await db.query('SELECT status FROM tarefas')).rows[0].status,'pendente')
  await db.query("INSERT INTO whatsapp_mensagens(lead_id,direcao,created_at) VALUES($1,'entrada',now())",[lead])
  assert.equal((await db.query('SELECT status FROM tarefas')).rows[0].status,'cancelada')
  console.log('PASS: resposta nova cancela adiamento; webhook antigo não cancela')
  const transfer='SELECT transferir_cliente_crm($1,$2,$3,$4,$5,$6)'
  await rejects('42501',transfer,[client,seller,other,'Reorganização','individual',true])
  await db.query(`CREATE FUNCTION falha_historico() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$;
    CREATE TRIGGER falha BEFORE INSERT ON clientes_vendedor_historico FOR EACH ROW EXECUTE FUNCTION falha_historico();`)
  await rejects('P0001',transfer,[client,admin,other,'Reorganização','individual',true])
  assert.equal((await db.query('SELECT responsavel_id FROM leads')).rows[0].responsavel_id,seller)
  assert.equal((await db.query('SELECT vendedor_responsavel_usuario_id AS owner FROM clientes_erp')).rows[0].owner,seller)
  await db.query('DROP TRIGGER falha ON clientes_vendedor_historico')
  await db.query(schedule,[id(),...args.slice(1)])
  await db.query(transfer,[client,admin,other,'Reorganização','individual',true])
  assert.equal((await db.query('SELECT responsavel_id FROM leads')).rows[0].responsavel_id,other)
  assert.equal((await db.query("SELECT responsavel_id FROM tarefas WHERE status='pendente'")).rows[0].responsavel_id,other)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM clientes_vendedor_historico')).rows[0].n,1)
  console.log('PASS: transferência atômica; falha no histórico preserva os donos; tarefa pendente acompanha opção')
  await db.query(`ALTER TABLE leads ADD nome text, ADD telefone text, ADD origem text DEFAULT 'whatsapp', ADD ultima_mensagem_em timestamptz, ADD criado_em timestamptz DEFAULT now();
    UPDATE leads SET nome='Antigo fora da página',ultima_mensagem_em='2020-01-01';
    UPDATE tarefas SET status='cancelada';`)
  await db.query(`INSERT INTO leads(id,responsavel_id,nome,origem,ultima_mensagem_em)
    SELECT gen_random_uuid(),$1,'Recente '||i,'whatsapp',now()+interval '1 minute' FROM generate_series(1,205) i`,[other])
  const inbox='SELECT listar_caixa_whatsapp($1,false,$2,false,$3,null,$4,$5) AS result'
  const all=(await db.query(inbox,[admin,other,'',null,200])).rows[0].result
  assert.equal(all.total,206)
  assert.equal(all.data.length,200)
  assert.ok(!all.data.some(l=>l.id===lead))
  const searched=(await db.query(inbox,[admin,other,'Antigo',null,200])).rows[0].result
  assert.equal(searched.total,1);assert.equal(searched.data[0].id,lead)
  assert.equal((await db.query(inbox,[seller,seller,'Antigo',null,200])).rows[0].result.total,0)
  await rejects('42501',inbox,[seller,other,'',null,200])
  assert.equal((await db.query(inbox,[admin,other,'','aguardando',200])).rows[0].result.total,1)
  assert.equal((await db.query(inbox,[admin,other,'','criticas',200])).rows[0].result.total,0)
  await db.query("UPDATE whatsapp_mensagens SET created_at=now()-interval '1 hour'")
  assert.equal((await db.query(inbox,[admin,other,'','criticas',200])).rows[0].result.total,1)
  console.log('PASS: busca e estados de espera filtram toda a carteira antes da paginação; snapshot único e autorização SQL')
} finally {
  await db.query('ROLLBACK').catch(()=>{})
  await db.end()
}
