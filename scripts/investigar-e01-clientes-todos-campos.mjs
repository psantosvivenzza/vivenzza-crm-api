// Investigação (03/08): Peterson reportou que endereço e representante do
// cliente "não puxaram" pro nosso sistema. Objetivo: listar TODAS as tabelas
// e colunas relacionadas a cliente no NetVision (e01), pra comparar com o que
// já existe em clientes_erp (Supabase) e identificar o que nunca foi migrado.
import 'dotenv/config'
import pg from 'pg'

const client = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await client.connect()

console.log('=== 1. TABELAS QUE PARECEM SER DE CLIENTE ===')
const { rows: tabelas } = await client.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND (table_name ILIKE '%client%' OR table_name ILIKE '%destinat%' OR table_name ILIKE '%repres%' OR table_name ILIKE '%vendedor%' OR table_name ILIKE '%endereco%' OR table_name ILIKE '%contato%')
  ORDER BY table_name
`)
console.log(JSON.stringify(tabelas, null, 2))

for (const { table_name } of tabelas) {
  console.log(`\n=== COLUNAS DE "${table_name}" ===`)
  const { rows: colunas } = await client.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [table_name])
  console.log(JSON.stringify(colunas, null, 2))

  const { rows: contagem } = await client.query(`SELECT count(*) FROM "${table_name}"`)
  console.log(`Total de registros: ${contagem[0].count}`)
}

await client.end()
