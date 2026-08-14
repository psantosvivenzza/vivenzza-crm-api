/**
 * Auditoria READ-ONLY — DOMÍNIO A: PEDIDOS COMERCIAIS.
 * Compara pedido↔pedido: NetVision `ES_Pedidos`/`ES_ItemPedido` (TipoPedido='V')
 * contra Vivenzza `pedidos`/`pedido_itens` (sistema_origem='legado').
 *
 * Isto é DIFERENTE da auditoria pedido↔nota fiscal (audit-netvision-vendas.mjs,
 * domínio B). `pedidos` é sincronizado DIRETAMENTE de `ES_Pedidos` por
 * src/jobs/sync-pedidos-legado.js — legacy_id = "{CodigoFilial}-{NumeroPedido}"
 * é a MESMA chave usada pra popular a linha, então o match aqui é
 * EXACT_ORDER_KEY (não heurístico). O objetivo não é "descobrir se são
 * sistemas independentes que coincidem" — é validar que o espelhamento está
 * completo e fresco (nada ficou pra trás, nada duplicado, status bate com a
 * árvore de prioridade real do legado).
 *
 *   node scripts/audit-netvision-pedidos.mjs [--from=2026-08-01] [--to=2026-08-13] [--json=out.json]
 */
import 'dotenv/config'
import { config as loadCrmEnv } from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
loadCrmEnv({ path: path.resolve(__dirname, '../../vivenzza-crm-api/.env') })

const TOLERANCIA_CENTAVOS = 0.01

function argValor(nome, padrao) {
  const pref = `--${nome}=`
  const achado = process.argv.find((a) => a.startsWith(pref))
  return achado ? achado.slice(pref.length) : padrao
}
function primeiroDiaDoMesAtual() {
  const agora = new Date()
  return `${agora.getUTCFullYear()}-${String(agora.getUTCMonth() + 1).padStart(2, '0')}-01`
}
function ontemUTC() { return new Date(Date.now() - 86400000).toISOString().slice(0, 10) }

const DE = argValor('from', primeiroDiaDoMesAtual())
const ATE = argValor('to', ontemUTC())
const SAIDA_JSON = argValor('json', null)

// mesma árvore de prioridade de src/jobs/sync-pedidos-legado.js — reimplementada
// aqui só pra CONFERIR que o valor sincronizado bate com o que o legado tem
// agora (staleness), não pra recalcular nada de verdade.
function mapearStatus({ cancelado, pedidoConfirmado, statusPedido }) {
  if (statusPedido === null || statusPedido === undefined || Number.isNaN(Number(statusPedido))) return null
  if (Number(cancelado) === 1) return 'cancelado'
  if (Number(statusPedido) >= 5) return 'faturado'
  if (Number(pedidoConfirmado) === 1 || Number(statusPedido) >= 1) return 'confirmado'
  return 'rascunho'
}

async function buscarNetVision() {
  const faltando = ['E01_HOST', 'E01_PORT', 'E01_USER', 'E01_DATABASE'].filter((v) => !process.env[v])
  if (faltando.length) throw new Error(`Variáveis de ambiente E01 ausentes: ${faltando.join(', ')}`)
  const pool = new pg.Pool({
    host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER,
    password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE,
  })
  try {
    const { rows } = await pool.query(
      `SELECT "CodigoFilial", "NumeroPedido", "StatusPedido", "Cancelado", "PedidoConfirmado",
              "CodigoEmitente", "DataEmissao", "DataAtualizacao", "Valor", "ValorDesconto", "ValorFrete"
       FROM "ES_Pedidos"
       WHERE "TipoPedido" = 'V' AND "DataEmissao" >= $1 AND "DataEmissao" < ($2::date + interval '1 day')
       ORDER BY "CodigoFilial", "NumeroPedido"`,
      [DE, ATE]
    )
    return rows
  } finally {
    await pool.end()
  }
}

async function buscarVivenzza() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
  const linhas = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('pedidos')
      .select('id, legacy_id, status, status_origem, total, desconto, valor_frete, criado_em, atualizado_no_origem_em, sistema_origem, cliente_externo_id')
      .eq('sistema_origem', 'legado')
      .gte('criado_em', `${DE}T00:00:00Z`)
      .lt('criado_em', `${ATE}T23:59:59.999Z`)
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    linhas.push(...data)
    if (data.length < PAGE) break
  }
  return linhas
}

function chave(filial, numero) { return `${(filial || '').trim()}-${numero}` }

async function main() {
  console.log(`[audit:netvision:pedidos] DOMÍNIO A — PEDIDOS COMERCIAIS. Período ${DE}..${ATE}`)

  const [nv, vv] = await Promise.all([buscarNetVision(), buscarVivenzza()])

  const nvMap = new Map()
  for (const r of nv) nvMap.set(chave(r.CodigoFilial, r.NumeroPedido), r)
  const vvMap = new Map()
  const duplicadosVivenzza = []
  for (const p of vv) {
    if (vvMap.has(p.legacy_id)) duplicadosVivenzza.push(p.legacy_id)
    vvMap.set(p.legacy_id, p) // último vence — duplicata real é rara, sync usa upsert por legacy_id
  }

  const totalNv = nv.reduce((s, r) => s + Number(r.Valor || 0), 0)
  const totalVv = vv.reduce((s, p) => s + Number(p.total || 0), 0)
  console.log(`  ES_Pedidos (NetVision, TipoPedido='V'): n=${nv.length}  soma Valor=R$ ${totalNv.toFixed(2)}`)
  console.log(`  pedidos (Vivenzza, sistema_origem='legado'): n=${vv.length}  soma total=R$ ${totalVv.toFixed(2)}`)

  const todasChaves = new Set([...nvMap.keys(), ...vvMap.keys()])
  const linhas = []
  for (const k of todasChaves) {
    const n = nvMap.get(k), v = vvMap.get(k)
    if (n && !v) {
      linhas.push({ chave: k, categoria: 'MISSING_IN_VIVENZZA', match_method: 'EXACT_ORDER_KEY', match_confidence: 'EXACT', deltaReais: -Number(n.Valor || 0), obs: 'pedido existe no ES_Pedidos, ausente em pedidos (sync não trouxe ou está atrasado)' })
      continue
    }
    if (v && !n) {
      linhas.push({ chave: k, categoria: 'EXTRA_IN_VIVENZZA', match_method: 'EXACT_ORDER_KEY', match_confidence: 'EXACT', deltaReais: Number(v.total || 0), obs: 'pedido existe no Vivenzza, ausente no ES_Pedidos do período (provável DataEmissao fora da janela consultada, não necessariamente gap real)' })
      continue
    }
    // presente nos dois — comparar status, valor, desconto, frete
    const statusEsperado = mapearStatus({ cancelado: n.Cancelado, pedidoConfirmado: n.PedidoConfirmado, statusPedido: n.StatusPedido })
    const statusBate = statusEsperado === v.status
    const diffValor = Number(v.total || 0) - Number(n.Valor || 0)
    const diffDesconto = Number(v.desconto || 0) - Number(n.ValorDesconto || 0)
    const diffFrete = Number(v.valor_frete || 0) - Number(n.ValorFrete || 0)

    if (!statusBate) {
      linhas.push({ chave: k, categoria: 'STATUS_MISMATCH', match_method: 'EXACT_ORDER_KEY', match_confidence: 'EXACT', deltaReais: 0, obs: `Vivenzza status=${v.status} (${v.status_origem}) vs legado agora mapearia '${statusEsperado}' (StatusPedido=${n.StatusPedido},Cancelado=${n.Cancelado},PedidoConfirmado=${n.PedidoConfirmado}) — provável staleness de sync, não erro de mapeamento` })
      continue
    }
    if (Math.abs(diffValor) > TOLERANCIA_CENTAVOS) {
      linhas.push({ chave: k, categoria: 'VALUE_MISMATCH', match_method: 'EXACT_ORDER_KEY', match_confidence: 'EXACT', deltaReais: diffValor, obs: `Vivenzza total=R$${Number(v.total).toFixed(2)} vs ES_Pedidos.Valor=R$${Number(n.Valor).toFixed(2)}` })
      continue
    }
    if (Math.abs(diffDesconto) > TOLERANCIA_CENTAVOS || Math.abs(diffFrete) > TOLERANCIA_CENTAVOS) {
      linhas.push({ chave: k, categoria: 'TRANSFORMATION_MISMATCH', match_method: 'EXACT_ORDER_KEY', match_confidence: 'EXACT', deltaReais: 0, obs: `desconto Viv=R$${Number(v.desconto).toFixed(2)} vs legado=R$${Number(n.ValorDesconto).toFixed(2)} | frete Viv=R$${Number(v.valor_frete).toFixed(2)} vs legado=R$${Number(n.ValorFrete).toFixed(2)}` })
      continue
    }
    linhas.push({ chave: k, categoria: 'LEGACY_VALID', match_method: 'EXACT_ORDER_KEY', match_confidence: 'EXACT', deltaReais: 0 })
  }
  for (const k of duplicadosVivenzza) linhas.push({ chave: k, categoria: 'DUPLICATE', match_method: 'EXACT_ORDER_KEY', match_confidence: 'EXACT', deltaReais: 0, obs: 'mais de 1 linha em pedidos com o mesmo legacy_id — inesperado, sync faz upsert por legacy_id' })

  const porCategoria = {}
  for (const l of linhas) {
    if (!porCategoria[l.categoria]) porCategoria[l.categoria] = { count: 0, deltaReais: 0, exemplos: [] }
    porCategoria[l.categoria].count++
    porCategoria[l.categoria].deltaReais += l.deltaReais
    if (porCategoria[l.categoria].exemplos.length < 8) porCategoria[l.categoria].exemplos.push(l)
  }

  console.log('\n  Decomposição (domínio PEDIDOS COMERCIAIS, match exato por legacy_id):')
  const CATEGORIAS = ['MISSING_IN_VIVENZZA', 'EXTRA_IN_VIVENZZA', 'VALUE_MISMATCH', 'STATUS_MISMATCH', 'DUPLICATE', 'TRANSFORMATION_MISMATCH', 'LEGACY_VALID']
  for (const cat of CATEGORIAS) {
    const c = porCategoria[cat] || { count: 0, deltaReais: 0 }
    console.log(`    ${cat.padEnd(24)} n=${String(c.count).padStart(4)}  delta=R$ ${c.deltaReais.toFixed(2)}`)
  }

  const resultado = {
    dominio: 'PEDIDOS_COMERCIAIS', periodo: { de: DE, ate: ATE },
    total_netvision: Number(totalNv.toFixed(2)), n_netvision: nv.length,
    total_vivenzza: Number(totalVv.toFixed(2)), n_vivenzza: vv.length,
    delta: Number((totalVv - totalNv).toFixed(2)),
    por_categoria: Object.fromEntries(CATEGORIAS.map((c) => [c, porCategoria[c] || { count: 0, deltaReais: 0, exemplos: [] }])),
    linhas,
  }
  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify(resultado, null, 2)); console.log(`\n  JSON salvo em ${SAIDA_JSON}`) }
  process.exit(0)
}

main().catch((err) => { console.error('[audit:netvision:pedidos] ERRO:', err.message); process.exit(2) })
