import 'dotenv/config'
import pg from 'pg'

const client = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await client.connect()

// Pedidos já conhecidos no CRM (por legacy_id) com status variados, pra comparar
// CodigoCliente vs CodigoDestinatario/CodigoEmitente lado a lado.
const numeros = [9696, 9693, 9699, 9700, 9724]
const { rows } = await client.query(`
  SELECT "CodigoFilial", "NumeroPedido", "StatusPedido", "Cancelado", "PedidoConfirmado",
         "CodigoCliente", "CodigoDestinatario", "CodigoEmitente", "DataEmissao"
  FROM "ES_Pedidos"
  WHERE "NumeroPedido" = ANY($1)
  ORDER BY "NumeroPedido"
`, [numeros])
console.log(JSON.stringify(rows, null, 2))

console.log('\n=== Quantos pedidos têm CodigoCliente vs CodigoDestinatario preenchido (amostra geral) ===')
const { rows: contagem } = await client.query(`
  SELECT
    COUNT(*) FILTER (WHERE TRIM("CodigoCliente") <> '') AS com_codigo_cliente,
    COUNT(*) FILTER (WHERE TRIM("CodigoDestinatario") <> '') AS com_codigo_destinatario,
    COUNT(*) FILTER (WHERE TRIM("CodigoEmitente") <> '') AS com_codigo_emitente,
    COUNT(*) AS total
  FROM "ES_Pedidos"
`)
console.log(JSON.stringify(contagem, null, 2))

await client.end()
