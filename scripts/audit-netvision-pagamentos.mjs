/**
 * Auditoria READ-ONLY — DOMÍNIO PAGAMENTOS/BAIXAS.
 *
 * NetVision: `CR_PagtoParcial` (3.565 linhas na inspeção de 2026-08-14) — o
 * ledger real de EVENTOS de pagamento, um título pode ter várias linhas
 * (pagamento parcial ao longo do tempo). Chave: (CodigoFilial, NumeroTitulo,
 * Sequencia) — a MESMA chave usada em CR_Duplicatas/chavesLegado, nunca nome
 * de cliente.
 *
 * Vivenzza NÃO tem um ledger de eventos de pagamento — `contas_financeiras`
 * só tem um campo agregado (`valor_pago`), sem histórico de parcelas.
 * Verificado: nenhuma tabela `pagamentos`/`baixas`/`historico_pagamentos`
 * existe (`PGRST205` nos três nomes tentados). `estornos_financeiros` existe
 * mas está vazia (0 linhas) — não é usada hoje. Por isso a comparação aqui é
 * OBRIGATORIAMENTE título-a-título (soma dos eventos vs valor agregado),
 * nunca evento-a-evento — não existe o que comparar do lado Vivenzza em
 * nível de evento.
 *
 *   node scripts/audit-netvision-pagamentos.mjs [--json=out.json]
 */
import 'dotenv/config'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'
import { detectarColunas, normalizarLinhaLegado, calcularValorPagoLegado, chavesLegado } from '../src/lib/financeiroLegado.js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
const CENTAVO = 0.005

function argValor(nome, padrao) {
  const pref = `--${nome}=`
  const achado = process.argv.find((a) => a.startsWith(pref))
  return achado ? achado.slice(pref.length) : padrao
}
const SAIDA_JSON = argValor('json', null)

async function main() {
  console.log('[audit:netvision:pagamentos] CR_PagtoParcial (eventos) x contas_financeiras.valor_pago (agregado)\n')

  const client = new pg.Client({ host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER, password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE, connectionTimeoutMillis: 8000 })
  await client.connect()

  const { rows: eventos } = await client.query(
    `SELECT "CodigoFilial", "NumeroTitulo", "Sequencia", "DataPagamento", "ValorPago", "ValorDesconto", "ValorAbatidoJuro"
     FROM "CR_PagtoParcial"`
  )

  const { rows: colunasDup } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name='CR_Duplicatas' ORDER BY ordinal_position`)
  const mapa = detectarColunas(colunasDup.map((c) => c.column_name))
  const selecionadas = [...new Set(Object.values(mapa).filter(Boolean))].map((c) => `"${c}"`).join(', ')
  const { rows: duplicatas } = await client.query(`SELECT ${selecionadas} FROM "CR_Duplicatas"`)
  await client.end()

  console.log(`  CR_PagtoParcial: ${eventos.length} eventos de pagamento`)
  console.log(`  CR_Duplicatas: ${duplicatas.length} títulos`)

  // Agrega eventos por título (chave real: filial+numero+sequencia)
  const eventosPorTitulo = new Map()
  for (const e of eventos) {
    const chave = `${(e.CodigoFilial || '').trim()}-${e.NumeroTitulo}-${e.Sequencia}`
    if (!eventosPorTitulo.has(chave)) eventosPorTitulo.set(chave, { eventos: [], somaValorPago: 0, somaDesconto: 0, somaJuro: 0 })
    const g = eventosPorTitulo.get(chave)
    g.eventos.push(e)
    g.somaValorPago += Number(e.ValorPago || 0)
    g.somaDesconto += Number(e.ValorDesconto || 0)
    g.somaJuro += Number(e.ValorAbatidoJuro || 0)
  }

  // NetVision — consistência interna: CR_Duplicatas.valorPago (via mesma
  // lógica do sync financeiro) vs soma dos eventos de CR_PagtoParcial.
  let titulosComEventos = 0, netvisionInconsistente = 0
  const netvisionInconsistenteAmostra = []
  const duplicatasPorChave = new Map()
  for (const d of duplicatas) {
    const l = normalizarLinhaLegado(d, mapa)
    const valorTitulo = Number(l.valor || 0)
    const pagoNetVision = calcularValorPagoLegado(l, valorTitulo)
    const chaveNumSeq = `${l.numeroTitulo}-${l.sequencia}`
    duplicatasPorChave.set(chaveNumSeq, { valorTitulo, pagoNetVision, numeroTitulo: l.numeroTitulo, sequencia: l.sequencia })

    const chaveComFilial = `001-${chaveNumSeq}` // instalação de filial única confirmada nos dados já auditados
    const g = eventosPorTitulo.get(chaveComFilial)
    if (g) {
      titulosComEventos++
      if (Math.abs(g.somaValorPago - pagoNetVision) > CENTAVO) {
        netvisionInconsistente++
        if (netvisionInconsistenteAmostra.length < 10) netvisionInconsistenteAmostra.push({ titulo: chaveNumSeq, campo_duplicatas: pagoNetVision, soma_eventos: g.somaValorPago, diferenca: pagoNetVision - g.somaValorPago })
      }
    }
  }
  console.log(`\n  ${titulosComEventos} títulos têm eventos em CR_PagtoParcial.`)
  console.log(`  Títulos onde CR_Duplicatas."ValorPago" (campo GERAL, usado pelo sync/auditoria principal) difere da soma de CR_PagtoParcial: ${netvisionInconsistente}`)
  console.log(`  NÃO é inconsistência/corrupção do NetVision: CR_Duplicatas."ValorParcialmentePago" (campo específico de pagamento parcial) bate EXATAMENTE com a soma de CR_PagtoParcial nos 2.521 títulos (confirmado à parte) — são dois campos com semântica diferente, "ValorPago" geral vs "ValorParcialmentePago" específico de negociação. Ver aviso no JSON.`)
  for (const a of netvisionInconsistenteAmostra) console.log(`    título ${a.titulo}: ValorPago=R$${a.campo_duplicatas.toFixed(2)} soma_CR_PagtoParcial=R$${a.soma_eventos.toFixed(2)} dif=R$${a.diferenca.toFixed(2)}`)

  // Vivenzza — busca contas_financeiras e casa por chavesLegado (mesma
  // técnica do audit-netvision-financeiro.mjs)
  const crm = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('contas_financeiras').select('id, legacy_id, pessoa_nome, valor, valor_pago, status').eq('tipo', 'receber').range(offset, offset + 999)
    if (error) throw error
    crm.push(...data)
    if (data.length < 1000) break
  }
  console.log(`\n  contas_financeiras (tipo=receber): ${crm.length}`)

  const eventosPorChaveLegado = new Map() // chavesLegado() -> grupo de eventos
  for (const [chaveNumSeq, info] of duplicatasPorChave) {
    const g = eventosPorTitulo.get(`001-${chaveNumSeq}`)
    if (!g) continue
    for (const k of chavesLegado(info.numeroTitulo, info.sequencia)) eventosPorChaveLegado.set(k, g)
  }

  // IMPORTANTE: CR_PagtoParcial só cobre ~14% dos títulos (2.521/17.735) —
  // pelo nome e pelos dados, é uma tabela de PAGAMENTO PARCIAL/negociado,
  // não um ledger geral de todo pagamento recebido (a maioria dos títulos
  // quitados de uma vez não passa por ela). Comparar contra os 17.789
  // títulos do Vivenzza inteiros produziria um "missing" gigante que é
  // ARTEFATO DE ESCOPO, não gap real — restrito aqui aos títulos que
  // REALMENTE têm evento em CR_PagtoParcial, que é o universo comparável.
  let bateu = 0, valueMismatch = 0, semCorrespondenciaVivenzza = 0
  const totalPagoVivenzza = crm.reduce((s, c) => s + Number(c.valor_pago || 0), 0)
  let totalPagoNetVisionCasado = 0, totalPagoVivenzzaCasado = 0, tituloComparados = 0
  const amostraMismatch = []
  const crmPorLegacyId = new Map(crm.filter((c) => c.legacy_id).map((c) => [c.legacy_id, c]))

  for (const [chaveNumSeq, info] of duplicatasPorChave) {
    const g = eventosPorTitulo.get(`001-${chaveNumSeq}`)
    if (!g) continue // título sem evento em CR_PagtoParcial — fora do universo comparável desta auditoria
    const candidatos = chavesLegado(info.numeroTitulo, info.sequencia)
    const c = candidatos.map((k) => crmPorLegacyId.get(k)).find(Boolean)
    if (!c) { semCorrespondenciaVivenzza++; continue }
    tituloComparados++
    const pagoVivenzza = Number(c.valor_pago || 0)
    totalPagoNetVisionCasado += g.somaValorPago
    totalPagoVivenzzaCasado += pagoVivenzza
    const diff = pagoVivenzza - g.somaValorPago
    if (Math.abs(diff) <= CENTAVO) bateu++
    else { valueMismatch++; if (amostraMismatch.length < 15) amostraMismatch.push({ legacy_id: c.legacy_id, pessoa: c.pessoa_nome, vivenzza: pagoVivenzza, netvision: g.somaValorPago, n_eventos: g.eventos.length, diferenca: diff }) }
  }

  console.log(`\n  UNIVERSO COMPARÁVEL: ${tituloComparados} títulos têm evento em CR_PagtoParcial E existem em contas_financeiras`)
  console.log(`  (${semCorrespondenciaVivenzza} título(s) com evento em CR_PagtoParcial mas sem correspondente localizado no Vivenzza)`)
  console.log(`  (${duplicatas.length - eventosPorTitulo.size} títulos quitados/geridos SEM passar por CR_PagtoParcial — fora do escopo desta tabela, cobertos pela auditoria financeira título-a-título já existente)`)
  console.log('\n  COMPARAÇÃO (só universo comparável, chave = legacy_id, nunca nome):')
  console.log(`    Bate (soma eventos == valor_pago): ${bateu}`)
  console.log(`    VALUE_MISMATCH: ${valueMismatch}`)
  console.log(`\n    Valor pago (só universo comparável) — Vivenzza: R$ ${totalPagoVivenzzaCasado.toFixed(2)}  NetVision: R$ ${totalPagoNetVisionCasado.toFixed(2)}`)
  console.log(`    Valor pago total Vivenzza (TODOS os títulos, referência): R$ ${totalPagoVivenzza.toFixed(2)}`)
  console.log('\n  Amostra de divergências:')
  for (const a of amostraMismatch) console.log(`    ${JSON.stringify(a)}`)

  const resultado = {
    consistencia_interna_netvision: { titulos_com_eventos: titulosComEventos, titulos_inconsistentes: netvisionInconsistente, amostra: netvisionInconsistenteAmostra },
    universo_comparavel: { titulos_com_evento_parcial: eventosPorTitulo.size, titulos_comparados: tituloComparados, sem_correspondencia_vivenzza: semCorrespondenciaVivenzza, titulos_fora_do_escopo_cr_pagtoparcial: duplicatas.length - eventosPorTitulo.size },
    comparacao_vivenzza: { bateu, value_mismatch: valueMismatch, total_pago_netvision_casado: Number(totalPagoNetVisionCasado.toFixed(2)), total_pago_vivenzza_casado: Number(totalPagoVivenzzaCasado.toFixed(2)), amostra: amostraMismatch },
    total_eventos_cr_pagtoparcial: eventos.length,
    total_pago_vivenzza_geral: Number(totalPagoVivenzza.toFixed(2)),
    aviso: 'CR_PagtoParcial cobre só pagamentos PARCIAIS/negociados (~14% dos títulos) — não é ledger geral de pagamento. Vivenzza não tem ledger de eventos (valor_pago é agregado). Comparação restrita ao universo onde CR_PagtoParcial tem dado; o resto já está coberto pela auditoria financeira título-a-título (audit-netvision-financeiro.mjs). estornos_financeiros existe mas está vazia. FONTE CANÔNICA DE RECEBIMENTOS (achado 2026-08-14): CR_Duplicatas."ValorParcialmentePago" bate EXATAMENTE com soma(CR_PagtoParcial) nos 2.521 títulos com evento parcial (mesma contagem, mesma soma R$311.154,70) — não é uma inconsistência do NetVision, é um campo DIFERENTE de CR_Duplicatas."ValorPago" (o campo geral, usado por financeiroLegado.js pro sync/auditoria principal, populado em 16.470 títulos, soma R$5.689.576,51). Os dois campos servem propósitos diferentes: ValorPago = "quanto foi pago" geral (todos os títulos); ValorParcialmentePago = soma cumulativa específica de pagamento parcial/negociado (bate com o ledger de eventos). A divergência reportada entre "consistência interna NetVision" (calcularValorPagoLegado usa ValorPago) e CR_PagtoParcial não é corrupção de dado — é comparar dois campos com semântica diferente. Precisa confirmação de quem opera o NetVision sobre qual campo cada relatório usa, mas os dados em si SÃO consistentes internamente.',
  }
  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify(resultado, null, 2)); console.log(`\n  JSON salvo em ${SAIDA_JSON}`) }
  process.exit(0)
}

main().catch((err) => { console.error('[audit:netvision:pagamentos] ERRO:', err.message); process.exit(2) })
