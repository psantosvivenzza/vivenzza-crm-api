/**
 * READ-ONLY — ponte pedido→documento fiscal, registro a registro, pros
 * representantes que entram no RE_Consulta02 (StatusPedido=5, Cancelado=0,
 * TipoPedido='V', filial 001, período 01-14/08/2026).
 *
 * Pra cada pedido, busca notas do MESMO CLIENTE numa janela larga (não só
 * o período estrito, pra pegar SALE_INVOICE_OTHER_PERIOD) e tenta casar por
 * valor (ValorNota ou ValorTotalProdutos). Sem vínculo de ID confiável
 * (confirmado em rodadas anteriores) — pareamento é sempre heurístico,
 * cada linha registra o método.
 *
 * NÃO altera nada. Só lê ES_Pedidos e EN_Notas (todo TipoNota, não só VEN,
 * pra pegar BON/NS/etc que expliquem o delta).
 *
 *   node scripts/ponte-pedido-nota.mjs --representante=000073 [--json=out.json]
 */
import 'dotenv/config'
import pg from 'pg'
import fs from 'node:fs'

function argValor(nome, padrao) { const p = `--${nome}=`; const a = process.argv.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : padrao }
const REPRESENTANTE = argValor('representante', null)
const SAIDA_JSON = argValor('json', null)
if (!REPRESENTANTE) { console.error('uso: --representante=000073'); process.exit(1) }

const DE = '2026-08-01', ATE = '2026-08-14'
const JANELA_ANTES_DIAS = 10, JANELA_DEPOIS_DIAS = 60
const CENTAVO = 0.01
const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const CFOP_VENDA = new Set(['5102', '6102'])

function somarDias(dataStr, dias) { const d = new Date(dataStr); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10) }
function dataISO(v) { return v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null }

async function main() {
  const client = new pg.Client({ host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER, password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE, connectionTimeoutMillis: 8000 })
  await client.connect()

  const { rows: pedidos } = await client.query(
    `SELECT "CodigoFilial","NumeroPedido","CodigoEmitente","DataEmissao","Valor"
     FROM "ES_Pedidos"
     WHERE "TipoPedido"='V' AND "CodigoFilial"='001' AND trim("Representante")=$1
       AND "StatusPedido"=5 AND "Cancelado"=0
       AND "DataEmissao" >= $2 AND "DataEmissao" < ($3::date + interval '1 day')
     ORDER BY "NumeroPedido"`,
    [REPRESENTANTE, DE, ATE]
  )
  console.log(`Pedidos qualificados (StatusPedido=5, Cancelado=0) pro representante ${REPRESENTANTE}: ${pedidos.length}, soma R$${fmt(pedidos.reduce((s, p) => s + Number(p.Valor), 0))}`)

  const linhas = []
  for (const p of pedidos) {
    const cliente = (p.CodigoEmitente || '').trim()
    const de = somarDias(dataISO(p.DataEmissao), -JANELA_ANTES_DIAS)
    const ate = somarDias(dataISO(p.DataEmissao), JANELA_DEPOIS_DIAS)

    const { rows: notas } = await client.query(
      `SELECT "NumeroNota","Serie","TipoNota","NaturezaOperacao1","DataEmissao","ValorNota","ValorTotalProdutos","Cancelada"
       FROM "EN_Notas"
       WHERE "CodigoFilial"='001' AND trim("Cliente")=$1
         AND "DataEmissao" >= $2 AND "DataEmissao" < ($3::date + interval '1 day')
       ORDER BY "DataEmissao"`,
      [cliente, de, ate]
    )

    const valorPedido = Number(p.Valor)
    const notasAtivas = notas.filter((n) => Number(n.Cancelada) === 0)
    const matchExato = notasAtivas.find((n) => Math.abs(Number(n.ValorNota) - valorPedido) <= CENTAVO || Math.abs(Number(n.ValorTotalProdutos) - valorPedido) <= CENTAVO)

    let classificacao, notaRelacionada = null, valorFiscalVenda = 0, obs = ''
    if (matchExato) {
      const cfop = (matchExato.NaturezaOperacao1 || '').trim()
      const mesmoPeriodo = dataISO(matchExato.DataEmissao) >= DE && dataISO(matchExato.DataEmissao) <= ATE
      if (CFOP_VENDA.has(cfop)) {
        valorFiscalVenda = Number(matchExato.ValorNota)
        classificacao = mesmoPeriodo ? 'SALE_INVOICE_SAME_PERIOD' : 'SALE_INVOICE_OTHER_PERIOD'
        obs = `nota ${matchExato.NumeroNota}, CFOP ${cfop}, emitida ${dataISO(matchExato.DataEmissao)}`
      } else {
        classificacao = 'ONLY_NON_SALE_CFOP'
        obs = `nota ${matchExato.NumeroNota} encontrada mas CFOP ${cfop} (${matchExato.TipoNota}) não é venda`
      }
    } else {
      // sem match exato — procura soma parcial (>1 nota) ou nota cancelada sem reemissão, ou nenhuma nota
      const somaAtivas = notasAtivas.reduce((s, n) => s + Number(n.ValorNota), 0)
      const canceladas = notas.filter((n) => Number(n.Cancelada) !== 0)
      const vendaAtivas = notasAtivas.filter((n) => CFOP_VENDA.has((n.NaturezaOperacao1 || '').trim()))
      const somaVendaAtivas = vendaAtivas.reduce((s, n) => s + Number(n.ValorNota), 0)
      if (notasAtivas.length > 1 && Math.abs(somaAtivas - valorPedido) <= CENTAVO) {
        const cfops = [...new Set(notasAtivas.map((n) => (n.NaturezaOperacao1 || '').trim()))]
        const todasVenda = notasAtivas.every((n) => CFOP_VENDA.has((n.NaturezaOperacao1 || '').trim()))
        valorFiscalVenda = todasVenda ? somaAtivas : notasAtivas.filter((n) => CFOP_VENDA.has((n.NaturezaOperacao1 || '').trim())).reduce((s, n) => s + Number(n.ValorNota), 0)
        classificacao = 'PARTIAL_SALE_INVOICE'
        obs = `${notasAtivas.length} notas somando o valor do pedido, CFOPs: ${cfops.join(',')}`
      } else if (vendaAtivas.length >= 1 && somaVendaAtivas > CENTAVO && somaVendaAtivas < valorPedido - CENTAVO) {
        // Nota(s) CFOP-venda ativa(s) encontrada(s), mas valor MENOR que o
        // pedido — faturamento parcial real (não é "vínculo não achado",
        // o vínculo está claro, só cobre uma fração do pedido).
        valorFiscalVenda = somaVendaAtivas
        classificacao = 'PARTIAL_SALE_INVOICE'
        obs = `${vendaAtivas.length} nota(s) CFOP venda ativa(s) somando R$${fmt(somaVendaAtivas)} — ${fmt(((somaVendaAtivas / valorPedido) * 100))}% do valor do pedido`
      } else if (notasAtivas.length === 0 && canceladas.length > 0) {
        classificacao = 'CANCELLED_WITHOUT_VALID_REISSUE'
        obs = `${canceladas.length} nota(s) cancelada(s) do cliente na janela, nenhuma reemissão ativa encontrada`
      } else if (notasAtivas.length === 0) {
        classificacao = 'NO_INVOICE_FOUND'
        obs = `nenhuma nota do cliente ${cliente} na janela -${JANELA_ANTES_DIAS}d/+${JANELA_DEPOIS_DIAS}d`
      } else {
        classificacao = 'INVOICE_LINK_NOT_FOUND'
        obs = `${notasAtivas.length} nota(s) ativa(s) do cliente na janela, nenhuma bate em valor (soma ativas=R$${fmt(somaAtivas)}), vínculo ambíguo`
      }
    }

    linhas.push({
      numero_pedido: p.NumeroPedido, cliente, data_emissao_pedido: dataISO(p.DataEmissao), valor_pedido: valorPedido,
      classificacao, valor_fiscal_venda: Number(valorFiscalVenda.toFixed(2)), delta: Number((valorPedido - valorFiscalVenda).toFixed(2)), obs,
      notas_encontradas: notas.map((n) => ({ numero: n.NumeroNota, cfop: (n.NaturezaOperacao1 || '').trim(), tipo: n.TipoNota, data: dataISO(n.DataEmissao), valor: Number(n.ValorNota), cancelada: Number(n.Cancelada) })),
    })
  }
  await client.end()

  const totalPedidos = linhas.reduce((s, l) => s + l.valor_pedido, 0)
  const totalFiscalVenda = linhas.reduce((s, l) => s + l.valor_fiscal_venda, 0)
  const totalDelta = linhas.reduce((s, l) => s + l.delta, 0)
  const porCategoria = {}
  for (const l of linhas) { if (!porCategoria[l.classificacao]) porCategoria[l.classificacao] = { n: 0, delta: 0 }; porCategoria[l.classificacao].n++; porCategoria[l.classificacao].delta += l.delta }

  console.log(`\nTotal pedidos: R$${fmt(totalPedidos)}  Total fiscal-venda encontrado: R$${fmt(totalFiscalVenda)}  Delta: R$${fmt(totalDelta)}`)
  console.log('\nPor categoria:')
  for (const [cat, v] of Object.entries(porCategoria)) console.log(`  ${cat.padEnd(32)} n=${v.n}  delta=R$${fmt(v.delta)}`)

  console.log('\nDetalhe por pedido:')
  for (const l of linhas) console.log(`  ${l.numero_pedido} cliente=${l.cliente} R$${fmt(l.valor_pedido)} → ${l.classificacao} (fiscal=R$${fmt(l.valor_fiscal_venda)}) — ${l.obs}`)

  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify({ representante: REPRESENTANTE, total_pedidos: Number(totalPedidos.toFixed(2)), total_fiscal_venda: Number(totalFiscalVenda.toFixed(2)), total_delta: Number(totalDelta.toFixed(2)), por_categoria: porCategoria, linhas }, null, 2)); console.log(`\nJSON salvo em ${SAIDA_JSON}`) }
  process.exit(0)
}

main().catch((err) => { console.error('ERRO:', err.message); process.exit(1) })
