/**
 * PREVIEW read-only — reprocessa os conflitos financeiros isolados
 * (em_revisao_financeira=true) usando a regra canônica descoberta:
 * ValorParcialmentePago (CR_Duplicatas) para títulos com evento em
 * CR_PagtoParcial, ValorPago (o campo geral, já usado por
 * calcularValorPagoLegado) pro resto.
 *
 * NÃO altera nenhum dado. Classifica cada conflito em:
 *   AUTO_RESOLVABLE_DETERMINISTIC — a regra canônica aplicada resolveria
 *     sozinha (ERP tem mais/igual que o CRM segundo o campo certo, ou é
 *     encerramento com saldo residual que o sync já aplicaria).
 *   HUMAN_REVIEW_REQUIRED — mesmo com o campo certo, CRM > ERP (bloqueado
 *     por desenho — nunca reverte pagamento automaticamente).
 *   LEGACY_DUPLICATE — título só existe no CRM (import e99), sem origem
 *     ERP pra comparar.
 *   NO_CHANGE_REQUIRED — não deveria aparecer aqui (só entra se o
 *     recálculo mostrar que na verdade já bate).
 *
 *   node scripts/preview-resolucao-conflitos-financeiro.mjs [--json=out.json]
 */
import 'dotenv/config'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import { detectarColunas, normalizarLinhaLegado, calcularValorPagoLegado, chavesLegado } from '../src/lib/financeiroLegado.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
const CENTAVO = 0.005
const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function argValor(nome, padrao) { const p = `--${nome}=`; const a = process.argv.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : padrao }
const SAIDA_JSON = argValor('json', null)

async function main() {
  console.log('[preview-resolucao-conflitos-financeiro] reprocessando com a regra canônica (ValorParcialmentePago x ValorPago) — SÓ PREVIEW\n')

  const client = new pg.Client({ host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER, password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE, connectionTimeoutMillis: 8000 })
  await client.connect()
  const { rows: colunas } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='CR_Duplicatas' ORDER BY ordinal_position`)
  const mapa = detectarColunas(colunas.map((c) => c.column_name))
  const selecionadas = [...new Set(Object.values(mapa).filter(Boolean))].map((c) => `"${c}"`).join(', ')
  const { rows: linhasErp } = await client.query(`SELECT ${selecionadas} FROM "CR_Duplicatas"`)
  const { rows: eventosParcial } = await client.query(`SELECT "CodigoFilial","NumeroTitulo","Sequencia","ValorPago" FROM "CR_PagtoParcial"`)
  await client.end()

  const somaParcialPorTitulo = new Map()
  for (const e of eventosParcial) {
    const k = `${e.NumeroTitulo}-${e.Sequencia}`
    somaParcialPorTitulo.set(k, (somaParcialPorTitulo.get(k) || 0) + Number(e.ValorPago || 0))
  }

  const erpPorChave = new Map()
  for (const r of linhasErp) {
    const l = normalizarLinhaLegado(r, mapa)
    const valorTitulo = Number(l.valor || 0)
    const pagoGeral = calcularValorPagoLegado(l, valorTitulo)
    const chaveNumSeq = `${l.numeroTitulo}-${l.sequencia}`
    const temEventoParcial = somaParcialPorTitulo.has(chaveNumSeq)
    const pagoCanonico = temEventoParcial ? somaParcialPorTitulo.get(chaveNumSeq) : pagoGeral
    const registro = {
      numeroTitulo: l.numeroTitulo, sequencia: l.sequencia, valor: valorTitulo,
      pagoGeral, pagoParcial: temEventoParcial ? somaParcialPorTitulo.get(chaveNumSeq) : null, temEventoParcial,
      pagoCanonico, saldoCanonico: valorTitulo - pagoCanonico, cancelado: l.cancelado, aberto: !l.cancelado && !l.encerrado,
    }
    for (const k of chavesLegado(l.numeroTitulo, l.sequencia)) erpPorChave.set(k, registro)
  }

  const crm = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('contas_financeiras').select('id, legacy_id, pessoa_nome, valor, valor_pago, status, em_revisao_financeira').eq('tipo', 'receber').range(offset, offset + 999)
    if (error) throw error
    crm.push(...data)
    if (data.length < 1000) break
  }
  const ABERTO_CRM = new Set(['aberta', 'vencida', 'pago_parcial'])

  const resultados = []
  for (const c of crm) {
    if (!c.em_revisao_financeira) continue
    const pagoCrm = Number(c.valor_pago || 0)
    if (!c.legacy_id) {
      resultados.push({ legacy_id: null, id: c.id, pessoa: c.pessoa_nome, classificacao: 'LEGACY_DUPLICATE', motivo: 'título manual sem legacy_id, sem origem ERP pra comparar', confianca: 'ALTA' })
      continue
    }
    const e = erpPorChave.get(c.legacy_id)
    if (!e) {
      resultados.push({ legacy_id: c.legacy_id, id: c.id, pessoa: c.pessoa_nome, classificacao: 'LEGACY_DUPLICATE', motivo: 'legacy_id não encontrado no NetVision (import e99 ou similar)', confianca: 'ALTA' })
      continue
    }

    const crmAberto = ABERTO_CRM.has(c.status)
    const statusMismatch = crmAberto !== e.aberto

    if (Math.abs(pagoCrm - e.pagoCanonico) <= CENTAVO && !statusMismatch) {
      resultados.push({ legacy_id: c.legacy_id, id: c.id, pessoa: c.pessoa_nome, classificacao: 'NO_CHANGE_REQUIRED', motivo: 'com o campo canônico, já bate', confianca: 'ALTA', valor_vivenzza: pagoCrm, valor_correto_regra_canonica: e.pagoCanonico, campo_usado: e.temEventoParcial ? 'ValorParcialmentePago' : 'ValorPago' })
      continue
    }

    if (pagoCrm > e.pagoCanonico + CENTAVO) {
      resultados.push({
        legacy_id: c.legacy_id, id: c.id, pessoa: c.pessoa_nome, classificacao: 'HUMAN_REVIEW_REQUIRED',
        motivo: `mesmo com o campo canônico (${e.temEventoParcial ? 'ValorParcialmentePago' : 'ValorPago'}), Vivenzza registra mais pago que o NetVision — bloqueado por desenho, nunca reverte`,
        confianca: 'ALTA', estado_netvision: e.aberto ? 'aberto' : 'encerrado', estado_vivenzza: c.status,
        valor_vivenzza: pagoCrm, valor_correto_regra_canonica: e.pagoCanonico, campo_usado: e.temEventoParcial ? 'ValorParcialmentePago' : 'ValorPago',
        status_atual: c.status, status_esperado: e.aberto ? (pagoCrm > 0 ? 'pago_parcial' : 'aberta/vencida') : 'paga', acao_proposta: 'nenhuma automática — revisão humana',
      })
      continue
    }

    // pagoCanonico > pagoCrm (ERP tem mais) OU status diverge com saldo residual — resolvível pela régua normal.
    resultados.push({
      legacy_id: c.legacy_id, id: c.id, pessoa: c.pessoa_nome, classificacao: 'AUTO_RESOLVABLE_DETERMINISTIC',
      motivo: statusMismatch ? 'status diverge (encerrado no ERP, aberto no CRM ou vice-versa) — a régua de sync já aplicaria' : `ERP tem mais pago (campo ${e.temEventoParcial ? 'ValorParcialmentePago' : 'ValorPago'}) que o Vivenzza — a régua de sync já aplicaria`,
      confianca: e.temEventoParcial ? 'MÉDIA (depende de qual campo o NetVision considera correto pra este título — não confirmado com quem opera o sistema)' : 'ALTA',
      estado_netvision: e.aberto ? 'aberto' : 'encerrado', estado_vivenzza: c.status,
      valor_vivenzza: pagoCrm, valor_correto_regra_canonica: e.pagoCanonico, campo_usado: e.temEventoParcial ? 'ValorParcialmentePago' : 'ValorPago',
      status_atual: c.status, status_esperado: e.aberto ? (e.pagoCanonico > 0 ? 'pago_parcial' : 'aberta/vencida') : 'paga',
      acao_proposta: `aplicar via decidirAtualizacao()/fn_sincronizar_baixa_legado — não executado nesta rodada`,
    })
  }

  const porClassificacao = {}
  for (const r of resultados) { if (!porClassificacao[r.classificacao]) porClassificacao[r.classificacao] = []; porClassificacao[r.classificacao].push(r) }

  console.log(`Total de conflitos reprocessados (em_revisao_financeira=true): ${resultados.length}\n`)
  for (const [cat, lista] of Object.entries(porClassificacao)) console.log(`  ${cat}: ${lista.length}`)

  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify({ total: resultados.length, por_classificacao: Object.fromEntries(Object.entries(porClassificacao).map(([k, v]) => [k, v.length])), resultados }, null, 2)); console.log(`\nJSON salvo em ${SAIDA_JSON}`) }

  // Markdown legível pra revisão humana
  let md = '# Preview — reprocessamento dos conflitos financeiros com a regra canônica\n\n'
  md += `Gerado ${new Date().toISOString()}. **NADA foi alterado** — isto é só o preview do que a régua de sync faria se rodasse, usando o campo correto (\`ValorParcialmentePago\` para títulos com pagamento negociado, \`ValorPago\` pro resto).\n\n`
  md += `Total reprocessado: ${resultados.length}\n\n`
  for (const [cat, lista] of Object.entries(porClassificacao)) {
    md += `## ${cat} (${lista.length})\n\n`
    md += '| legacy_id | pessoa | valor Vivenzza | valor correto (regra canônica) | campo usado | status atual | status esperado | ação proposta |\n|---|---|---|---|---|---|---|---|\n'
    for (const r of lista) {
      md += `| ${r.legacy_id || '(sem)'} | ${r.pessoa} | ${r.valor_vivenzza != null ? 'R$ ' + fmt(r.valor_vivenzza) : '-'} | ${r.valor_correto_regra_canonica != null ? 'R$ ' + fmt(r.valor_correto_regra_canonica) : '-'} | ${r.campo_usado || '-'} | ${r.status_atual || '-'} | ${r.status_esperado || '-'} | ${r.acao_proposta || r.motivo} |\n`
    }
    md += '\n'
  }
  fs.writeFileSync('PREVIEW_RESOLUCAO_125_CONFLITOS.md', md)
  console.log('\nArquivo gerado: PREVIEW_RESOLUCAO_125_CONFLITOS.md')

  process.exit(0)
}

main().catch((err) => { console.error('ERRO:', err.message); process.exit(1) })
