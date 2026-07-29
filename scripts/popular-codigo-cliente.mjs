/**
 * Popula contas_financeiras.codigo_cliente a partir de CR_Duplicatas.CodigoCliente
 * (batendo por título+sequência, extraído do legacy_id — mesmo padrão usado pra
 * telefone_cobranca e valor_pago). Cobre tanto legacy_id='cr-*' quanto '001-*'.
 * Requer que a coluna já exista (migrations/contas_financeiras_codigo_cliente.sql).
 *
 * node scripts/popular-codigo-cliente.mjs
 */
import 'dotenv/config'
import pg from 'pg'
import { supabase } from '../src/lib/supabase.js'

const client = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await client.connect()

const { rows } = await client.query(`
  SELECT "NumeroTitulo", "Sequencia", TRIM("CodigoCliente") AS codigo_cliente
  FROM "CR_Duplicatas"
`)
await client.end()
console.log(`Legado: ${rows.length} linhas (título/seq → código de cliente)`)

const mapa = new Map()
for (const r of rows) mapa.set(`${r.NumeroTitulo}-${r.Sequencia}`, r.codigo_cliente)

// Todas as linhas com legacy_id no formato cr-*/001-* e ainda sem codigo_cliente
const contas = []
const PAGE = 1000
for (let offset = 0; ; offset += PAGE) {
  const { data, error } = await supabase
    .from('contas_financeiras')
    .select('id, legacy_id')
    .is('codigo_cliente', null)
    .not('legacy_id', 'is', null)
    .range(offset, offset + PAGE - 1)
  if (error) throw error
  contas.push(...data)
  if (data.length < PAGE) break
}
console.log(`Linhas sem codigo_cliente pra tentar preencher: ${contas.length}`)

let atualizados = 0
let semMatch = 0

const aAtualizar = []
for (const c of contas) {
  const m = c.legacy_id.match(/^(?:cr|001)-(\d+)-(\d+)$/)
  if (!m) continue
  const codigo = mapa.get(`${m[1]}-${m[2]}`)
  if (!codigo) { semMatch++; continue }
  aAtualizar.push({ id: c.id, codigo })
}

// Updates em paralelo (lotes de 20) — sequencial pra 17k+ linhas levaria horas.
const CONCORRENCIA = 20
for (let i = 0; i < aAtualizar.length; i += CONCORRENCIA) {
  const lote = aAtualizar.slice(i, i + CONCORRENCIA)
  const resultados = await Promise.all(
    lote.map(({ id, codigo }) => supabase.from('contas_financeiras').update({ codigo_cliente: codigo }).eq('id', id))
  )
  for (const r of resultados) {
    if (r.error) throw r.error
    atualizados++
  }
  if ((i / CONCORRENCIA) % 25 === 0) console.log(`  progresso: ${atualizados}/${aAtualizar.length}`)
}

console.log(`\nAtualizados: ${atualizados}`)
console.log(`Sem match no legado: ${semMatch}`)
