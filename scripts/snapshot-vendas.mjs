/**
 * READ-ONLY — snapshot único "as of agora" dos três indicadores, calculados
 * no MESMO instante (nunca mais comparar consulta ao vivo com print antigo):
 *
 *   A) PEDIDOS DO MÊS       — pedidos.total, status='faturado' (Vivenzza)
 *   B) VENDAS FISCAIS DO MÊS — nota válida + CFOP venda (5102/6102) +
 *                               não cancelada + DataEmissao no período (NetVision)
 *   C) RE_CONSULTA02 (reproduzido) — pedido StatusPedido=5/Cancelado=0 MENOS
 *      pedidos cujo(s) documento(s) fiscal(is) são só CFOP não-venda
 *      (fórmula verificada em VENDAS_DO_MES_RECONCILIACAO.md)
 *
 * Período: 01/08/2026 00:00:00 até 14/08/2026 23:59:59, filial 001.
 *
 *   node scripts/snapshot-vendas.mjs [--json=out.json]
 */
import 'dotenv/config'
import pg from 'pg'
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
const DE = '2026-08-01', ATE = '2026-08-14'
const CFOP_VENDA = new Set(['5102', '6102'])
const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function argValor(nome, padrao) { const p = `--${nome}=`; const a = process.argv.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : padrao }
const SAIDA_JSON = argValor('json', null)

async function main() {
  const timestampSnapshot = new Date().toISOString()
  console.log(`[snapshot-vendas] as-of ${timestampSnapshot} — período ${DE}..${ATE}, filial 001\n`)

  const client = new pg.Client({ host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER, password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE, connectionTimeoutMillis: 8000 })
  await client.connect()

  // B) VENDAS FISCAIS DO MÊS — direto de EN_Notas, regra homologada
  const { rows: notasVenda } = await client.query(
    `SELECT "NumeroNota", trim("Comissionado") as representante, "DataEmissao","ValorNota","NaturezaOperacao1"
     FROM "EN_Notas"
     WHERE "CodigoFilial"='001' AND "TipoNota"='VEN' AND "Cancelada"=0
       AND trim("NaturezaOperacao1") IN ('5102','6102')
       AND "DataEmissao" >= $1 AND "DataEmissao" < ($2::date + interval '1 day')`,
    [DE, ATE]
  )
  const vendasFiscaisPorRep = {}
  for (const n of notasVenda) {
    const rep = n.representante || '(sem representante)'
    if (!vendasFiscaisPorRep[rep]) vendasFiscaisPorRep[rep] = { n: 0, valor: 0 }
    vendasFiscaisPorRep[rep].n++
    vendasFiscaisPorRep[rep].valor += Number(n.ValorNota)
  }
  const totalVendasFiscais = notasVenda.reduce((s, n) => s + Number(n.ValorNota), 0)

  // C) RE_Consulta02 reproduzido — pedido StatusPedido=5/Cancelado=0 menos
  // pedidos cujos documentos fiscais ativos são só CFOP não-venda.
  const { rows: pedidos } = await client.query(
    `SELECT "NumeroPedido", trim("Representante") as representante, trim("CodigoEmitente") as cliente, "DataEmissao","Valor"
     FROM "ES_Pedidos"
     WHERE "CodigoFilial"='001' AND "TipoPedido"='V' AND "StatusPedido"=5 AND "Cancelado"=0
       AND "DataEmissao" >= $1 AND "DataEmissao" < ($2::date + interval '1 day')`,
    [DE, ATE]
  )
  const reConsulta02PorRep = {}
  for (const p of pedidos) {
    const rep = p.representante || '(sem representante)'
    if (!reConsulta02PorRep[rep]) reConsulta02PorRep[rep] = { n: 0, valor: 0, nPedidos: 0 }
    reConsulta02PorRep[rep].nPedidos++

    // documento(s) fiscal(is) ativos do cliente no período — checagem rápida
    // (mesma janela usada na ponte pedido-nota) só pra decidir inclusão/exclusão
    const { rows: docs } = await client.query(
      `SELECT "NaturezaOperacao1","ValorNota" FROM "EN_Notas"
       WHERE "CodigoFilial"='001' AND trim("Cliente")=$1 AND "Cancelada"=0
         AND "DataEmissao" >= ($2::date - interval '10 days') AND "DataEmissao" < ($2::date + interval '61 days')`,
      [p.cliente, dataISO(p.DataEmissao)]
    )
    const todosNaoVenda = docs.length > 0 && docs.every((d) => !CFOP_VENDA.has((d.NaturezaOperacao1 || '').trim()))
    if (!todosNaoVenda) { reConsulta02PorRep[rep].n++; reConsulta02PorRep[rep].valor += Number(p.Valor) }
  }
  await client.end()
  function dataISO(v) { return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10) }

  const totalReConsulta02 = Object.values(reConsulta02PorRep).reduce((s, r) => s + r.valor, 0)

  // A) PEDIDOS DO MÊS — Vivenzza, mesma lógica do dashboard real
  const { data: pedidosVivenzza, error } = await supabase.from('pedidos')
    .select('total, vendedor_nome')
    .eq('status', 'faturado')
    .or('classificacao_faturamento.eq.venda,classificacao_faturamento.is.null')
    .gte('criado_em', `${DE}T03:00:00.000Z`)
    .lt('criado_em', '2026-08-15T02:59:59.999Z') // meia-noite local (America/Sao_Paulo) do dia seguinte a ATE
  if (error) throw error
  const totalPedidosDoMes = pedidosVivenzza.reduce((s, p) => s + Number(p.total), 0)

  console.log('A) PEDIDOS DO MÊS (Vivenzza, dashboard atual):', pedidosVivenzza.length, 'pedidos, R$', fmt(totalPedidosDoMes))
  console.log('B) VENDAS FISCAIS DO MÊS (nota+CFOP venda):', notasVenda.length, 'notas, R$', fmt(totalVendasFiscais))
  console.log('C) RE_CONSULTA02 reproduzido:', pedidos.length, 'pedidos qualificados, R$', fmt(totalReConsulta02))

  console.log('\nVendas fiscais por representante:')
  for (const [rep, v] of Object.entries(vendasFiscaisPorRep)) console.log(`  ${rep}: n=${v.n} R$${fmt(v.valor)}`)
  console.log('\nRE_Consulta02 reproduzido por representante:')
  for (const [rep, v] of Object.entries(reConsulta02PorRep)) console.log(`  ${rep}: n=${v.n}/${v.nPedidos} pedidos R$${fmt(v.valor)}`)

  const resultado = {
    timestamp_snapshot: timestampSnapshot, periodo: { de: DE, ate: ATE }, filial: '001',
    pedidos_do_mes: { n: pedidosVivenzza.length, valor: Number(totalPedidosDoMes.toFixed(2)) },
    vendas_fiscais_do_mes: { n: notasVenda.length, valor: Number(totalVendasFiscais.toFixed(2)), por_representante: vendasFiscaisPorRep },
    re_consulta02_reproduzido: { n: pedidos.length, valor: Number(totalReConsulta02.toFixed(2)), por_representante: reConsulta02PorRep },
  }
  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify(resultado, null, 2)); console.log(`\nJSON salvo em ${SAIDA_JSON}`) }
  process.exit(0)
}

main().catch((err) => { console.error('ERRO:', err.message); process.exit(1) })
