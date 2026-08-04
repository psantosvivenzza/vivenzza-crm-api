// Backfill (2026-08-04): os 9.155 pedidos já sincronizados do legado
// (NetVision/e01) nunca tiveram vendedor_id/vendedor_nome preenchidos — o
// job de sincronização (src/jobs/sync-pedidos-legado.js) lia
// ES_Pedidos.Representante mas descartava o valor. O job já foi corrigido
// pra gravar isso daqui pra frente; este script corrige o histórico já
// importado, usando exatamente o mesmo casamento estrito de nome
// (buscarMapaVendedores/normalizarNomeVendedor) que o job usa.
//
// Roda com `node scripts/backfill-vendedor-pedidos-legado.mjs` — precisa
// estar na máquina com acesso à rede do DESKTOP-Q6O54R1 (mesma limitação de
// scripts/sync-pedidos-legado.mjs). Idempotente: pode rodar de novo sem
// problema (sobrescreve com o mesmo resultado).
import 'dotenv/config'
import pg from 'pg'
import { supabase } from '../src/lib/supabase-admin.server.js'
import { buscarMapaVendedores } from '../src/jobs/sync-pedidos-legado.js'

const e01 = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
})
await e01.connect()
console.log('Conectado na NetVision (e01).')

const mapaVendedores = await buscarMapaVendedores(e01)
console.log(`Mapa de vendedores carregado: ${mapaVendedores.size} representantes na NetVision.`)
const semUsuarioCorrespondente = [...mapaVendedores.entries()].filter(([, v]) => !v.vendedor_id)
if (semUsuarioCorrespondente.length > 0) {
  console.log(`AVISO: ${semUsuarioCorrespondente.length} representante(s) sem usuário correspondente no CRM (vendedor_nome será gravado, vendedor_id ficará null):`)
  for (const [codigo, v] of semUsuarioCorrespondente) console.log(`  ${codigo} — "${v.vendedor_nome}"`)
}

const { rows: pedidosLegado } = await e01.query(`
  SELECT TRIM("CodigoFilial") AS filial, "NumeroPedido" AS numero, TRIM("Representante") AS rep_codigo
  FROM "ES_Pedidos" WHERE "TipoPedido" = 'V'
`)
console.log(`${pedidosLegado.length} pedidos de venda encontrados na NetVision. Iniciando atualização no Supabase...`)

let atualizados = 0, semRepresentante = 0, semUsuario = 0, semPedidoCorrespondente = 0, erros = 0, processados = 0
const inicio = Date.now()

for (const row of pedidosLegado) {
  processados++
  const legacyId = `${row.filial}-${row.numero}`
  if (!row.rep_codigo) { semRepresentante++; continue }

  const vendedor = mapaVendedores.get(row.rep_codigo)
  if (!vendedor) { semRepresentante++; continue } // código não cadastrado em EN_Representantes — não deveria acontecer, mas não trava o backfill

  const { data, error } = await supabase
    .from('pedidos')
    .update({ vendedor_id: vendedor.vendedor_id, vendedor_nome: vendedor.vendedor_nome })
    .eq('sistema_origem', 'legado')
    .eq('legacy_id', legacyId)
    .select('id')
  if (error) { erros++; continue }
  if (!data || data.length === 0) { semPedidoCorrespondente++; continue }
  atualizados++
  if (!vendedor.vendedor_id) semUsuario++ // pedido atualizado, mas só com vendedor_nome (sem usuário correspondente)

  if (processados % 200 === 0 || processados === pedidosLegado.length) {
    const segs = Math.round((Date.now() - inicio) / 1000)
    console.log(`... ${processados}/${pedidosLegado.length} processados (${segs}s) — atualizados: ${atualizados}, sem representante: ${semRepresentante}, sem pedido correspondente: ${semPedidoCorrespondente}, erros: ${erros}`)
  }
}

console.log('\nCONCLUÍDO')
console.log('Atualizados (vendedor_nome gravado):', atualizados)
console.log('  dos quais com vendedor_id resolvido:', atualizados - semUsuario)
console.log('  dos quais só vendedor_nome (sem usuário correspondente):', semUsuario)
console.log('Sem representante no legado (código vazio ou não cadastrado):', semRepresentante)
console.log('Sem pedido correspondente ainda sincronizado no CRM:', semPedidoCorrespondente)
console.log('Erros:', erros)

await e01.end()
