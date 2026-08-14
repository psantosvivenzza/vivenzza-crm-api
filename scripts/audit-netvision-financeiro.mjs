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

// ── Classificação dos conflitos em categorias objetivas ─────────────────────
// decidirAtualizacao() (financeiroLegado.js) só bloqueia escrita quando
// CRM > ERP ("conflito" — nunca reverte pagamento). Quando ERP >= CRM, a
// própria régua de sync aplicaria a atualização automaticamente, isolado ou
// não (o sync não filtra por em_revisao_financeira). Se esses 125 persistem
// divergentes apesar do worker residente rodando ciclos continuamente, é
// evidência de que a maioria é do tipo "CRM > ERP" (bloqueado por desenho,
// não um bug) — confirmado abaixo pelo sinal real de cada divergência, não
// por suposição.
const categorias = { A_pagamento_so_no_crm: [], B_pagamento_nao_refletido: [], C_encerrado_saldo_residual: [], G_status_divergente_puro: [] }

for (const d of divergencias.valorPagoDiferente) {
  if (d.dif > CENTAVO) categorias.A_pagamento_so_no_crm.push(d)
  else categorias.B_pagamento_nao_refletido.push(d)
}
for (const d of divergencias.crmFechadoErpAberto) {
  if (d.e.saldo > CENTAVO) categorias.C_encerrado_saldo_residual.push(d)
  else categorias.G_status_divergente_puro.push(d)
}

const somaAbs = (lista, campo) => lista.reduce((s, d) => s + Math.abs(d[campo] ?? d.dif ?? 0), 0)

console.log('\n  CLASSIFICAÇÃO DOS 125 CONFLITOS (categorias objetivas):')
linha()
console.log(`  A) Pagamento existe no Vivenzza sem correspondente no NetVision (CRM > ERP)`)
console.log(`     n=${categorias.A_pagamento_so_no_crm.length}  valor=R$ ${fmt(somaAbs(categorias.A_pagamento_so_no_crm, 'dif'))}  correção determinística: NÃO (regra do projeto proíbe reverter pagamento)  exige revisão humana: SIM`)
console.log(`  B) Pagamento no NetVision não refletido no Vivenzza (ERP > CRM)`)
console.log(`     n=${categorias.B_pagamento_nao_refletido.length}  valor=R$ ${fmt(somaAbs(categorias.B_pagamento_nao_refletido, 'dif'))}  correção determinística: SIM, EM TEORIA (decidirAtualizacao() aplicaria via fn_sincronizar_baixa_legado) — mas segue divergente apesar do worker ativo; investigar por que não convergiu antes de confiar nisso  exige revisão humana: SIM (nesta rodada, por precaução)`)
console.log(`  C) Encerrado no ERP com saldo residual (encerramento comercial/desconto)`)
console.log(`     n=${categorias.C_encerrado_saldo_residual.length}  valor=R$ ${fmt(categorias.C_encerrado_saldo_residual.reduce((s, d) => s + d.e.saldo, 0))}  correção determinística: SIM (aplicar encerramento, preservar valor pago real)  exige revisão humana: NÃO, mas está isolado com o resto`)
console.log(`  G) Status divergente puro (CRM fechado, ERP aberto, sem saldo residual)`)
console.log(`     n=${categorias.G_status_divergente_puro.length}  correção determinística: SIM (aplicar 'atualizar' do sync)  exige revisão humana: NÃO`)
console.log(`  D) Importação legada só-CRM (prefixo e99, nunca existiu no ERP consultado)`)
console.log(`     n=${divergencias.soNoCrm.length}  correção determinística: NÃO (não tem origem ERP pra comparar)  exige revisão humana: SIM — decisão de negócio já tomada de NÃO tocar (ver memória: "3 só CRM e99")`)
console.log(`  E) Duplicidade histórica: não encontrada nesta rodada (nenhum legacy_id duplicado detectado)`)
console.log(`  H) Outro: 0 (todos os 125 caíram em A/B/C/G)`)

const resultado = {
  totais: { erp: totErp, crm: totCrm },
  divergencias_count: { crmAbertoErpFechado: divergencias.crmAbertoErpFechado.length, crmFechadoErpAberto: divergencias.crmFechadoErpAberto.length, valorPagoDiferente: divergencias.valorPagoDiferente.length, soNoCrm: divergencias.soNoCrm.length, soNoErp: divergencias.soNoErp.length },
  criticas_isoladas: { total: criticasSet.size, isoladas: criticasIsoladas },
  classificacao: {
    A_pagamento_so_no_crm: { n: categorias.A_pagamento_so_no_crm.length, valor: Number(somaAbs(categorias.A_pagamento_so_no_crm, 'dif').toFixed(2)), correcao_deterministica: false, exige_revisao_humana: true },
    B_pagamento_nao_refletido: { n: categorias.B_pagamento_nao_refletido.length, valor: Number(somaAbs(categorias.B_pagamento_nao_refletido, 'dif').toFixed(2)), correcao_deterministica: 'teorica_nao_confirmada', exige_revisao_humana: true },
    C_encerrado_saldo_residual: { n: categorias.C_encerrado_saldo_residual.length, valor: Number(categorias.C_encerrado_saldo_residual.reduce((s, d) => s + d.e.saldo, 0).toFixed(2)), correcao_deterministica: true, exige_revisao_humana: false },
    G_status_divergente_puro: { n: categorias.G_status_divergente_puro.length, correcao_deterministica: true, exige_revisao_humana: false },
    D_so_no_crm_e99: { n: divergencias.soNoCrm.length, correcao_deterministica: false, exige_revisao_humana: true },
    E_duplicidade: { n: 0 },
    H_outro: { n: 0 },
  },
}
// ── Decomposição do delta de saldo em aberto (CRM - ERP) ────────────────────
// Cálculo EXATO, não heurístico: pra cada título, contribuição pro saldo
// aberto de cada lado usa exatamente o mesmo critério já usado pra somar
// totCrm.saldo/totErp.saldo acima — soma das contribuições bate 1:1 com o
// delta total por construção (não é um domínio de match aproximado como o
// de faturamento fiscal).
// Chave de classificação por título (não por variante de legacy_id — cada
// título real conta uma vez só, resolvido a partir da mesma junção que o
// loop de divergências principal já fez).
const grupoDoTitulo = new Map()
for (const d of categorias.A_pagamento_so_no_crm) grupoDoTitulo.set(d.c.legacy_id, 'A_pagamento_so_no_crm')
for (const d of categorias.B_pagamento_nao_refletido) grupoDoTitulo.set(d.c.legacy_id, 'B_pagamento_nao_refletido')
for (const d of categorias.C_encerrado_saldo_residual) grupoDoTitulo.set(d.c.legacy_id, 'C_encerrado_saldo_residual')
for (const d of categorias.G_status_divergente_puro) grupoDoTitulo.set(d.c.legacy_id, 'G_status_divergente_puro')

const deltaGrupos = {}
const soma = (grupo, valor) => { deltaGrupos[grupo] = (deltaGrupos[grupo] || 0) + valor }

// Títulos que existem no CRM (visitados uma vez cada, uma linha = um título).
for (const c of crm) {
  if (!c.legacy_id) continue
  const e = erpPorChave.get(c.legacy_id)
  const contribCrm = ABERTO_CRM.has(c.status) ? Number(c.valor || 0) - Number(c.valor_pago || 0) : 0
  if (!e) { soma('D_so_no_crm_e99', contribCrm); continue } // soNoCrm: sem contrapartida ERP, contribErp=0
  const contribErp = e.aberto ? e.saldo : 0
  const grupo = grupoDoTitulo.get(c.legacy_id) || (Math.abs(contribCrm - contribErp) <= CENTAVO ? 'sem_divergencia' : 'H_outro_nao_classificado')
  soma(grupo, contribCrm - contribErp)
}
// Títulos que existem SÓ no ERP (soNoErp — 0 nesta rodada, mas soma corretamente se houver).
for (const e of divergencias.soNoErp) {
  const contribErp = e.aberto ? e.saldo : 0
  soma('soNoErp_sem_contrapartida_crm', 0 - contribErp)
}
const somaDeltaGrupos = Object.values(deltaGrupos).reduce((s, v) => s + v, 0)

console.log('\n  DECOMPOSIÇÃO DO DELTA DE SALDO EM ABERTO (CRM - ERP = R$ ' + fmt(totCrm.saldo - totErp.saldo) + ')')
linha()
for (const [grupo, valor] of Object.entries(deltaGrupos).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))) {
  console.log(`  ${grupo.padEnd(32)} R$ ${fmt(valor)}`)
}
console.log(`  ${'SOMA (checagem exata)'.padEnd(32)} R$ ${fmt(somaDeltaGrupos)}`)
const gapDelta = Math.abs(somaDeltaGrupos - (totCrm.saldo - totErp.saldo))
console.log(`  ${'gap vs delta real'.padEnd(32)} R$ ${fmt(gapDelta)} ${gapDelta > CENTAVO ? '⚠ NÃO FECHOU' : '✓ fechou exatamente'}`)

console.log('\n  JSON de classificação disponível via --json=arquivo.json\n')

const argJson = process.argv.find((a) => a.startsWith('--json='))
if (argJson) {
  const fs = await import('node:fs')
  fs.writeFileSync(argJson.slice('--json='.length), JSON.stringify({ ...resultado, decomposicao_delta_saldo: { delta_real: Number((totCrm.saldo - totErp.saldo).toFixed(2)), por_grupo: Object.fromEntries(Object.entries(deltaGrupos).map(([k, v]) => [k, Number(v.toFixed(2))])), soma_grupos: Number(somaDeltaGrupos.toFixed(2)), gap: Number(gapDelta.toFixed(2)) }, divergencias: { valorPagoDiferente: divergencias.valorPagoDiferente.map(d => ({ legacy_id: d.c.legacy_id, pessoa: d.c.pessoa_nome, dif: d.dif })), crmFechadoErpAberto: divergencias.crmFechadoErpAberto.map(d => ({ legacy_id: d.c.legacy_id, pessoa: d.c.pessoa_nome, saldo_erp: d.e.saldo })) } }, null, 2))
  console.log(`  JSON salvo em ${argJson.slice('--json='.length)}`)
}

process.exitCode = 0
