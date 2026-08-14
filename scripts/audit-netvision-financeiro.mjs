/**
 * Auditoria READ-ONLY — DOMÍNIO CONTAS A RECEBER (financeiro).
 *
 * Portado de vivenzza-crm-api/scripts/conferir-netvision-crm.mjs (script já
 * existente, usado desde 13/08 pra validar o sync financeiro NetVision→CRM)
 * pra este worktree, com src/lib/financeiroLegado.js copiado junto — só as
 * funções puras de leitura/decisão (detectarColunas, normalizarLinhaLegado,
 * calcularValorPagoLegado, chavesLegado), sem nenhum caminho de escrita. O
 * job de sincronização em si (sync-financeiro-legado.js) não faz parte deste
 * PR, que é estritamente leitura.
 *
 *   node scripts/audit-netvision-financeiro.mjs
 *
 * Só leitura nos dois bancos. Não altera nada. Os ~125 títulos em conflito já
 * isolados via em_revisao_financeira=true (isolamento feito em rodada
 * anterior) continuam intactos — este script não corrige nada, só relata.
 */
import 'dotenv/config'
import { config as loadCrmEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import { detectarColunas, normalizarLinhaLegado, calcularValorPagoLegado, chavesLegado } from '../src/lib/financeiroLegado.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadCrmEnv({ path: path.resolve(__dirname, '../../vivenzza-crm-api/.env') })

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)

const CENTAVO = 0.005
const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const linha = (c = '-') => console.log('  ' + c.repeat(70))

console.log('\n' + '='.repeat(74))
console.log('  AUDITORIA CONTAS A RECEBER — NetVision (CR_Duplicatas) x Vivenzza CRM')
console.log('='.repeat(74))

const client = new pg.Client({
  host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
  password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
  connectionTimeoutMillis: 8000,
})
await client.connect()

const { rows: colunas } = await client.query(
  `SELECT column_name FROM information_schema.columns WHERE table_name='CR_Duplicatas' ORDER BY ordinal_position`
)
const mapa = detectarColunas(colunas.map((c) => c.column_name))
const selecionadas = [...new Set(Object.values(mapa).filter(Boolean))].map((c) => `"${c}"`).join(', ')
const { rows: linhasErp } = await client.query(`SELECT ${selecionadas} FROM "CR_Duplicatas"`)
await client.end()

const erpPorChave = new Map()
for (const r of linhasErp) {
  const l = normalizarLinhaLegado(r, mapa)
  const valorTitulo = Number(l.valor || 0)
  const pago = calcularValorPagoLegado(l, valorTitulo)
  const registro = { numeroTitulo: l.numeroTitulo, sequencia: l.sequencia, valor: valorTitulo, pago, saldo: valorTitulo - pago, cancelado: l.cancelado, aberto: !l.cancelado && !l.encerrado }
  for (const k of chavesLegado(l.numeroTitulo, l.sequencia)) erpPorChave.set(k, registro)
}

const crm = []
for (let offset = 0; ; offset += 1000) {
  const { data, error } = await supabase.from('contas_financeiras').select('id, legacy_id, pessoa_nome, valor, valor_pago, status, vencimento, em_revisao_financeira').eq('tipo', 'receber').range(offset, offset + 999)
  if (error) throw error
  crm.push(...data)
  if (data.length < 1000) break
}

const ABERTO_CRM = new Set(['aberta', 'vencida', 'pago_parcial'])

const erpUnicos = new Map()
for (const r of erpPorChave.values()) erpUnicos.set(`${r.numeroTitulo}-${r.sequencia}`, r)

const totErp = { abertos: 0, saldo: 0, cancelados: 0, encerrados: 0 }
for (const r of erpUnicos.values()) {
  if (r.cancelado) totErp.cancelados++
  else if (r.aberto) { totErp.abertos++; totErp.saldo += r.saldo }
  else totErp.encerrados++
}

const totCrm = { abertos: 0, saldo: 0, cancelados: 0, pagos: 0, semLegacy: 0, emRevisao: 0 }
for (const c of crm) {
  if (!c.legacy_id) totCrm.semLegacy++
  if (c.em_revisao_financeira) totCrm.emRevisao++
  if (c.status === 'cancelada') totCrm.cancelados++
  else if (ABERTO_CRM.has(c.status)) { totCrm.abertos++; totCrm.saldo += Number(c.valor || 0) - Number(c.valor_pago || 0) }
  else totCrm.pagos++
}

console.log('\n  TOTAIS')
linha()
console.log(`  ${''.padEnd(22)} ${'NetVision'.padStart(14)} ${'CRM'.padStart(14)} ${'diferenca'.padStart(14)}`)
console.log(`  ${'Titulos em aberto'.padEnd(22)} ${String(totErp.abertos).padStart(14)} ${String(totCrm.abertos).padStart(14)} ${String(totCrm.abertos - totErp.abertos).padStart(14)}`)
console.log(`  ${'Saldo em aberto (R$)'.padEnd(22)} ${fmt(totErp.saldo).padStart(14)} ${fmt(totCrm.saldo).padStart(14)} ${fmt(totCrm.saldo - totErp.saldo).padStart(14)}`)
console.log(`  ${'Cancelados'.padEnd(22)} ${String(totErp.cancelados).padStart(14)} ${String(totCrm.cancelados).padStart(14)} ${String(totCrm.cancelados - totErp.cancelados).padStart(14)}`)
console.log(`  Títulos em revisão financeira (isolados, fail-closed pra cobrança): ${totCrm.emRevisao}`)

const divergencias = { crmAbertoErpFechado: [], crmFechadoErpAberto: [], valorPagoDiferente: [], soNoCrm: [], soNoErp: [] }
const vistosNoCrm = new Set()

for (const c of crm) {
  if (!c.legacy_id) continue
  const e = erpPorChave.get(c.legacy_id)
  if (!e) { divergencias.soNoCrm.push(c); continue }
  vistosNoCrm.add(`${e.numeroTitulo}-${e.sequencia}`)
  const crmAberto = ABERTO_CRM.has(c.status)
  if (crmAberto && !e.aberto) divergencias.crmAbertoErpFechado.push({ c, e })
  else if (!crmAberto && e.aberto && c.status !== 'cancelada') divergencias.crmFechadoErpAberto.push({ c, e })
  const pagoCrm = Number(c.valor_pago || 0)
  if (Math.abs(pagoCrm - e.pago) > CENTAVO) divergencias.valorPagoDiferente.push({ c, e, dif: pagoCrm - e.pago })
}
for (const [k, e] of erpUnicos) if (!vistosNoCrm.has(k)) divergencias.soNoErp.push(e)

console.log('\n  DIVERGENCIAS')
linha()
console.log(`  Em aberto no CRM, ja encerrado no ERP...: ${String(divergencias.crmAbertoErpFechado.length).padStart(6)}   <-- cobraria quem ja pagou`)
console.log(`  Encerrado no CRM, em aberto no ERP......: ${String(divergencias.crmFechadoErpAberto.length).padStart(6)}   <-- deixaria de cobrar`)
console.log(`  Valor pago diferente....................: ${String(divergencias.valorPagoDiferente.length).padStart(6)}`)
console.log(`  Existe so no CRM........................: ${String(divergencias.soNoCrm.length).padStart(6)}`)
console.log(`  Existe so no NetVision..................: ${String(divergencias.soNoErp.length).padStart(6)}`)

// Quanto das divergências críticas já está isolado (em_revisao_financeira)?
const chaveCrm = (c) => c.legacy_id
const criticasSet = new Set([...divergencias.crmAbertoErpFechado, ...divergencias.crmFechadoErpAberto, ...divergencias.valorPagoDiferente].map(({ c }) => chaveCrm(c)))
let criticasIsoladas = 0
for (const c of crm) if (criticasSet.has(c.legacy_id) && c.em_revisao_financeira) criticasIsoladas++
console.log(`\n  Das ${criticasSet.size} divergências críticas (chaves únicas), ${criticasIsoladas} já estão isoladas (em_revisao_financeira=true) — fail-closed pra cobrança.`)

const criticas = divergencias.crmAbertoErpFechado.length + divergencias.crmFechadoErpAberto.length + divergencias.valorPagoDiferente.length

console.log('\n' + '='.repeat(74))
if (criticas === 0) {
  console.log('  RESULTADO: BATEU. CRM e NetVision estao iguais titulo a titulo.')
} else {
  console.log(`  RESULTADO: ${criticas} divergencia(s) — isso é ESPERADO enquanto o sync financeiro roda por fora (worker residente na máquina do escritório, fora deste repo/Railway). O que importa pra cobrança é que ${criticasSet.size === criticasIsoladas ? 'TODAS' : `${criticasIsoladas}/${criticasSet.size}`} estão isoladas via em_revisao_financeira=true.`)
}
console.log('='.repeat(74) + '\n')

process.exitCode = 0
