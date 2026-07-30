import 'dotenv/config'
import pg from 'pg'
import { supabase } from '../src/lib/supabase.js'

const client = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await client.connect()

const { rows } = await client.query(`
  SELECT DISTINCT TRIM("CodigoEmitente") as codigo FROM "ES_Pedidos"
  WHERE TRIM("CodigoEmitente") <> '' ORDER BY 1 LIMIT 20
`)
await client.end()
console.log('Amostra de CodigoEmitente distintos:', rows.map(r => r.codigo))

const codigos = rows.map(r => r.codigo)
const { data: clientes } = await supabase
  .from('clientes_erp')
  .select('legacy_id, razao_social')
  .in('legacy_id', codigos)
console.log(`\nDe ${codigos.length} códigos, ${clientes?.length ?? 0} batem com clientes_erp.legacy_id:`)
console.log(JSON.stringify(clientes, null, 2))
