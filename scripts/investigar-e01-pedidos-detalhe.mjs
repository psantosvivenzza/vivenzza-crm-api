import 'dotenv/config'
import pg from 'pg'
import { supabase } from '../src/lib/supabase.js'

const client = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await client.connect()

console.log('=== ES_StatusPedido (todos os status conhecidos) ===')
const { rows: status } = await client.query(`SELECT * FROM "ES_StatusPedido" ORDER BY "TipoPedido", "StatusPedidoConf"`)
console.log(JSON.stringify(status, null, 2))

console.log('\n=== Distinct TipoPedido em ES_Pedidos ===')
const { rows: tipos } = await client.query(`SELECT "TipoPedido", COUNT(*) FROM "ES_Pedidos" GROUP BY "TipoPedido" ORDER BY 2 DESC`)
console.log(JSON.stringify(tipos, null, 2))

console.log('\n=== Amostra de 5 linhas recentes de ES_Pedidos ===')
const { rows: amostra } = await client.query(`
  SELECT "CodigoFilial", "NumeroPedido", "TipoPedido", "StatusPedido", "Cancelado", "PedidoConfirmado",
         "CodigoCliente", "DataEmissao", "DataAtualizacao", "Valor", "Representante", "NumeroPedidoExterno", "OrigemPedido"
  FROM "ES_Pedidos" ORDER BY "DataAtualizacao" DESC NULLS LAST LIMIT 5
`)
console.log(JSON.stringify(amostra, null, 2))

console.log('\n=== Total de linhas em ES_Pedidos e range de datas ===')
const { rows: totais } = await client.query(`
  SELECT COUNT(*), MIN("DataEmissao") as min_emissao, MAX("DataEmissao") as max_emissao,
         MIN("DataAtualizacao") as min_atualizacao, MAX("DataAtualizacao") as max_atualizacao
  FROM "ES_Pedidos"
`)
console.log(JSON.stringify(totais, null, 2))

await client.end()

// Agora confirma o formato do legacy_id já gravado em pedidos (Supabase) pra
// tentar reconstruir a chave de match contra ES_Pedidos (CodigoFilial+NumeroPedido?)
console.log('\n=== Amostra de pedidos.legacy_id (Supabase) ===')
const { data: pedidosAmostra } = await supabase
  .from('pedidos')
  .select('id, legacy_id, criado_em, status, total')
  .not('legacy_id', 'is', null)
  .order('criado_em', { ascending: false })
  .limit(10)
console.log(JSON.stringify(pedidosAmostra, null, 2))
