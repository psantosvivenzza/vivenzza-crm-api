import 'dotenv/config'
import pg from 'pg'

const client = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await client.connect()

const { rows: tabelas } = await client.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema='public' AND (table_name ILIKE '%pedido%' OR table_name ILIKE '%venda%' OR table_name ILIKE '%orcamento%')
  ORDER BY table_name
`)
console.log('Tabelas candidatas no e01:', tabelas.map(t => t.table_name))

for (const t of tabelas) {
  const { rows: colunas } = await client.query(`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position
  `, [t.table_name])
  console.log(`\n--- ${t.table_name} ---`)
  console.log(colunas.map(c => `${c.column_name} (${c.data_type})`).join(', '))
}

await client.end()
