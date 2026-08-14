/**
 * Análise READ-ONLY dos títulos financeiros duplicados entre os dois formatos
 * históricos de legacy_id ("cr-{titulo}-{seq}" e "{filial}-{titulo}-{seq}").
 *
 * NÃO deduplica nada — só descreve cada par e classifica se dá pra apontar
 * um registro canônico com segurança ou não.
 *
 *   node scripts/analise-duplicados-financeiro.mjs [--json=out.json] [--csv=out.csv]
 */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)

function argValor(nome, padrao) {
  const pref = `--${nome}=`
  const achado = process.argv.find((a) => a.startsWith(pref))
  return achado ? achado.slice(pref.length) : padrao
}
const SAIDA_JSON = argValor('json', null)
const SAIDA_CSV = argValor('csv', null)

function normalizar(legacyId) {
  if (!legacyId) return null
  const m = legacyId.match(/^(?:cr|[0-9]{3})-(\d+)-(\d+)$/)
  return m ? `${m[1]}-${m[2]}` : null
}
function prefixo(legacyId) {
  const m = legacyId.match(/^(cr|[0-9]{3})-/)
  return m ? m[1] : '?'
}

async function main() {
  console.log('[analise-duplicados-financeiro] título a título, dos dois formatos de legacy_id\n')

  const crm = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase
      .from('contas_financeiras')
      .select('id, legacy_id, pessoa_nome, valor, valor_pago, status, vencimento, created_at, origem_lancamento, sincronizado_legado_em, codigo_cliente, em_revisao_financeira')
      .eq('tipo', 'receber')
      .range(offset, offset + 999)
    if (error) throw error
    crm.push(...data)
    if (data.length < 1000) break
  }

  const grupos = new Map()
  for (const c of crm) {
    const n = normalizar(c.legacy_id)
    if (!n) continue
    if (!grupos.has(n)) grupos.set(n, [])
    grupos.get(n).push(c)
  }
  const duplicados = [...grupos.entries()].filter(([, rows]) => rows.length > 1)

  console.log(`  Total de grupos com mais de 1 linha: ${duplicados.length}`)

  const analise = []
  for (const [tituloNorm, rows] of duplicados) {
    const linhas = rows.map((c) => ({
      id: c.id,
      legacy_id: c.legacy_id,
      prefixo: prefixo(c.legacy_id),
      pessoa_nome: c.pessoa_nome,
      valor: Number(c.valor),
      valor_pago: Number(c.valor_pago),
      status: c.status,
      vencimento: c.vencimento,
      created_at: c.created_at,
      origem_lancamento: c.origem_lancamento,
      sincronizado_legado_em: c.sincronizado_legado_em,
      codigo_cliente: c.codigo_cliente,
      em_revisao_financeira: c.em_revisao_financeira,
    }))

    // Mesmo título NetVision? valor e pessoa (aproximado) devem bater.
    const valores = new Set(linhas.map((l) => l.valor.toFixed(2)))
    const pessoas = new Set(linhas.map((l) => (l.pessoa_nome || '').trim().toLowerCase()))
    const mesmoTitulo = valores.size === 1 // valor é o critério forte — nome pode ter grafia diferente entre cargas

    let classificacao, motivo
    if (!mesmoTitulo) {
      classificacao = 'NOT_DUPLICATE'
      motivo = `valores diferentes entre as linhas (${[...valores].join(' vs ')}) — provavelmente títulos distintos que só coincidem no NumeroTitulo-Sequencia numérico`
    } else {
      // Critério de "mais completo": tem codigo_cliente preenchido, tem origem_lancamento, foi sincronizado mais recentemente.
      const completude = (l) => (l.codigo_cliente ? 1 : 0) + (l.origem_lancamento ? 1 : 0) + (l.sincronizado_legado_em ? 1 : 0)
      const maisCompleto = linhas.reduce((a, b) => (completude(b) > completude(a) ? b : a))
      const maisRecente = linhas.reduce((a, b) => (new Date(b.sincronizado_legado_em || b.created_at) > new Date(a.sincronizado_legado_em || a.created_at) ? b : a))
      const maisAntigo = linhas.reduce((a, b) => (new Date(b.created_at) < new Date(a.created_at) ? b : a))

      if (maisCompleto.id === maisRecente.id) {
        classificacao = 'CANONICAL_CANDIDATE_CLEAR'
        motivo = `linha ${maisCompleto.legacy_id} é a mais completa E a mais recentemente sincronizada — candidata clara a canônica`
      } else {
        classificacao = 'CANONICAL_CANDIDATE_AMBIGUOUS'
        motivo = `mais completa (${maisCompleto.legacy_id}) e mais recente (${maisRecente.legacy_id}) são linhas diferentes — não dá pra decidir automaticamente`
      }
      linhas.forEach((l) => { l.mais_completo = l.id === maisCompleto.id; l.mais_recente_sync = l.id === maisRecente.id; l.mais_antigo = l.id === maisAntigo.id })
    }

    analise.push({ titulo_normalizado: tituloNorm, n_linhas: linhas.length, classificacao, motivo, linhas })
  }

  const porClassificacao = {}
  for (const a of analise) porClassificacao[a.classificacao] = (porClassificacao[a.classificacao] || 0) + 1
  console.log('\n  Classificação:')
  for (const [k, v] of Object.entries(porClassificacao)) console.log(`    ${k}: ${v}`)

  console.log('\n  Detalhe (primeiros 10):')
  for (const a of analise.slice(0, 10)) {
    console.log(`\n  Título ${a.titulo_normalizado} — ${a.classificacao}`)
    console.log(`    ${a.motivo}`)
    for (const l of a.linhas) {
      console.log(`    ${l.legacy_id} (id=${l.id}) pessoa="${l.pessoa_nome}" valor=R$${l.valor.toFixed(2)} pago=R$${l.valor_pago.toFixed(2)} status=${l.status} criado=${l.created_at} origem=${l.origem_lancamento || '(nulo)'}`)
    }
  }

  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify({ total_grupos: duplicados.length, por_classificacao: porClassificacao, analise }, null, 2)); console.log(`\n  JSON salvo em ${SAIDA_JSON}`) }
  if (SAIDA_CSV) {
    const header = 'titulo,classificacao,legacy_id,id,pessoa,valor,valor_pago,status,vencimento,created_at,origem_lancamento,mais_completo,mais_recente_sync\n'
    const linhasCsv = []
    for (const a of analise) for (const l of a.linhas) linhasCsv.push(`${a.titulo_normalizado},${a.classificacao},${l.legacy_id},${l.id},"${(l.pessoa_nome || '').replace(/"/g, "'")}",${l.valor},${l.valor_pago},${l.status},${l.vencimento},${l.created_at},${l.origem_lancamento || ''},${l.mais_completo ?? ''},${l.mais_recente_sync ?? ''}`)
    fs.writeFileSync(SAIDA_CSV, header + linhasCsv.join('\n'))
    console.log(`  CSV salvo em ${SAIDA_CSV}`)
  }
  process.exit(0)
}

main().catch((err) => { console.error('[analise-duplicados-financeiro] ERRO:', err.message); process.exit(2) })
