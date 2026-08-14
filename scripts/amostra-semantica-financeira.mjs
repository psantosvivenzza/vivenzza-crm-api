/**
 * READ-ONLY — amostra representativa pra revisão humana da semântica de
 * ValorPago x ValorParcialmentePago (CR_Duplicatas). NÃO decide nada, NÃO
 * altera nada — só junta, lado a lado, tudo que dá pra ver sobre cada
 * título de uma amostra deliberadamente diversa:
 *   - 10 títulos onde valor_pago (Vivenzza) concorda com ValorPago;
 *   - 10 onde concorda com ValorParcialmentePago;
 *   - os 15 AUTO_RESOLVABLE_DETERMINISTIC (preview já existente);
 *   - títulos com pagamento parcial real (evento em CR_PagtoParcial,
 *     saldo > 0);
 *   - títulos quitados (saldo = 0, com ou sem evento parcial);
 *   - títulos encerrados no ERP com saldo residual.
 *
 *   node scripts/amostra-semantica-financeira.mjs [--json=out.json]
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
  const client = new pg.Client({ host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER, password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE, connectionTimeoutMillis: 8000 })
  await client.connect()
  const { rows: colunas } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='CR_Duplicatas' ORDER BY ordinal_position`)
  const mapa = detectarColunas(colunas.map((c) => c.column_name))
  const selecionadas = [...new Set(Object.values(mapa).filter(Boolean))].map((c) => `"${c}"`).join(', ')
  const { rows: linhasErp } = await client.query(`SELECT ${selecionadas} FROM "CR_Duplicatas"`)
  const { rows: eventosParcial } = await client.query(`SELECT "NumeroTitulo","Sequencia","DataPagamento","ValorPago","ValorDesconto","ValorAbatidoJuro" FROM "CR_PagtoParcial"`)
  await client.end()

  const eventosPorTitulo = new Map()
  for (const e of eventosParcial) {
    const k = `${e.NumeroTitulo}-${e.Sequencia}`
    if (!eventosPorTitulo.has(k)) eventosPorTitulo.set(k, [])
    eventosPorTitulo.get(k).push(e)
  }

  const erpPorChave = new Map()
  const erpPorNumSeq = new Map()
  for (const r of linhasErp) {
    const l = normalizarLinhaLegado(r, mapa)
    const valorTitulo = Number(l.valor || 0)
    const pagoGeral = calcularValorPagoLegado(l, valorTitulo)
    const chaveNumSeq = `${l.numeroTitulo}-${l.sequencia}`
    const eventos = eventosPorTitulo.get(chaveNumSeq) || []
    const somaParcial = eventos.reduce((s, e) => s + Number(e.ValorPago || 0), 0)
    const registro = {
      numeroTitulo: l.numeroTitulo, sequencia: l.sequencia, valorTitulo, pagoGeral,
      pagoParcial: eventos.length ? somaParcial : null, temEventoParcial: eventos.length > 0,
      nEventos: eventos.length, cancelado: l.cancelado, encerrado: l.encerrado, aberto: !l.cancelado && !l.encerrado,
      saldoGeral: valorTitulo - pagoGeral,
    }
    erpPorChave.set(`cr-${chaveNumSeq}`, registro)
    erpPorChave.set(`001-${chaveNumSeq}`, registro)
    erpPorNumSeq.set(chaveNumSeq, registro)
  }

  const crm = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('contas_financeiras').select('id, legacy_id, pessoa_nome, valor, valor_pago, status, em_revisao_financeira').eq('tipo', 'receber').range(offset, offset + 999)
    if (error) throw error
    crm.push(...data)
    if (data.length < 1000) break
  }

  const linhas = []
  for (const c of crm) {
    if (!c.legacy_id) continue
    const e = erpPorChave.get(c.legacy_id)
    if (!e) continue
    const pagoCrm = Number(c.valor_pago || 0)
    const concordaGeral = Math.abs(pagoCrm - e.pagoGeral) <= CENTAVO
    const concordaParcial = e.temEventoParcial && Math.abs(pagoCrm - e.pagoParcial) <= CENTAVO
    linhas.push({
      legacy_id: c.legacy_id, id: c.id, pessoa: c.pessoa_nome, em_revisao: c.em_revisao_financeira,
      valor_titulo: e.valorTitulo, valor_pago_crm: pagoCrm, status_crm: c.status,
      valor_pago_geral_nv: e.pagoGeral, valor_pago_parcial_nv: e.pagoParcial, n_eventos_parcial: e.nEventos,
      concorda_geral: concordaGeral, concorda_parcial: concordaParcial,
      cancelado_nv: e.cancelado, encerrado_nv: e.encerrado, aberto_nv: e.aberto, saldo_geral_nv: e.saldoGeral,
    })
  }

  const soConcordaGeral = linhas.filter((l) => l.concorda_geral && !l.concorda_parcial).slice(0, 10)
  const soConcordaParcial = linhas.filter((l) => l.concorda_parcial && !l.concorda_geral).slice(0, 10)
  const parciaisComSaldo = linhas.filter((l) => l.n_eventos_parcial > 0 && l.saldo_geral_nv > CENTAVO).slice(0, 10)
  const quitados = linhas.filter((l) => Math.abs(l.saldo_geral_nv) <= CENTAVO && l.valor_pago_crm > 0).slice(0, 10)
  const encerradosComSaldo = linhas.filter((l) => l.encerrado_nv && l.saldo_geral_nv > CENTAVO).slice(0, 10)

  console.log(`Amostra: ${soConcordaGeral.length} só-ValorPago | ${soConcordaParcial.length} só-ValorParcialmentePago | ${parciaisComSaldo.length} parciais-com-saldo | ${quitados.length} quitados | ${encerradosComSaldo.length} encerrados-com-saldo`)

  const resultado = { so_concorda_valor_pago_geral: soConcordaGeral, so_concorda_valor_parcialmente_pago: soConcordaParcial, parciais_com_saldo: parciaisComSaldo, quitados, encerrados_com_saldo: encerradosComSaldo }

  let md = '# Amostra representativa — semântica financeira (ValorPago x ValorParcialmentePago)\n\n'
  md += `Gerado ${new Date().toISOString()}. READ-ONLY, nada alterado.\n\n`
  const secao = (titulo, lista, desc) => {
    let s = `## ${titulo}\n\n${desc}\n\n`
    s += '| legacy_id | pessoa | valor título | valor_pago CRM | status CRM | em_revisão | ValorPago (geral) | ValorParcialmentePago | n eventos | saldo (geral) | NV aberto/encerrado |\n|---|---|---|---|---|---|---|---|---|---|---|\n'
    for (const l of lista) {
      s += `| ${l.legacy_id} | ${l.pessoa} | R$ ${fmt(l.valor_titulo)} | R$ ${fmt(l.valor_pago_crm)} | ${l.status_crm} | ${l.em_revisao} | R$ ${fmt(l.valor_pago_geral_nv)} | ${l.valor_pago_parcial_nv != null ? 'R$ ' + fmt(l.valor_pago_parcial_nv) : '-'} | ${l.n_eventos_parcial} | R$ ${fmt(l.saldo_geral_nv)} | ${l.aberto_nv ? 'aberto' : l.cancelado_nv ? 'cancelado' : 'encerrado'} |\n`
    }
    return s + '\n'
  }
  md += secao('10 títulos que concordam SÓ com ValorPago (geral)', soConcordaGeral, 'valor_pago do Vivenzza bate com ValorPago, não com ValorParcialmentePago.')
  md += secao('10 títulos que concordam SÓ com ValorParcialmentePago', soConcordaParcial, 'valor_pago do Vivenzza bate com ValorParcialmentePago, não com ValorPago — os mesmos títulos investigados na rodada anterior.')
  md += secao('Pagamentos parciais reais com saldo em aberto', parciaisComSaldo, 'Têm evento em CR_PagtoParcial e ainda têm saldo (valor - ValorPago geral > 0) segundo o campo geral.')
  md += secao('Títulos quitados (saldo = 0)', quitados, 'Sem saldo pendente segundo o campo geral.')
  md += secao('Encerrados no ERP com saldo residual', encerradosComSaldo, 'Marcados como encerrados no NetVision mas ainda com saldo > 0 no campo geral — acordo/desconto/baixa comercial.')

  fs.writeFileSync('AMOSTRA_SEMANTICA_FINANCEIRA.md', md)
  console.log('Arquivo gerado: AMOSTRA_SEMANTICA_FINANCEIRA.md')

  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify(resultado, null, 2)); console.log(`JSON salvo em ${SAIDA_JSON}`) }
  process.exit(0)
}

main().catch((err) => { console.error('ERRO:', err.message); process.exit(1) })
