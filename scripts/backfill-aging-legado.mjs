/**
 * Frente 3 do módulo de cobrança — raio-x dos devedores do legado + backfill.
 * railway run --service vivenzza-crm-api node scripts/backfill-aging-legado.mjs
 *
 * 1. Roda a query de devedores do legado (vencimento < hoje) e reporta:
 *    total de devedores, valor total, distribuição por faixa, top 20 maiores.
 * 2. Backfill de telefone_cobranca: casa pessoa_nome (normalizado) contra
 *    clientes_erp.razao_social/nome_fantasia, puxa celular/fone de `contatos`.
 * 3. Backfill de vendedor_id: só para títulos com pedido_id (pedidos.vendedor_id).
 *
 * Idempotente — pode rodar mais de uma vez sem duplicar nada (só faz UPDATE).
 */
import 'dotenv/config'
import { supabase } from '../src/lib/supabase.js'

const normalizar = (s) => (s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos (marcas diacríticas combinantes)
  .toUpperCase()
  .replace(/[^A-Z0-9 ]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

const TIPOS_TELEFONE = ['celular', 'fone', 'telefone', 'contato']
const fmtBRL = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

async function buscarTodos(tabela, select) {
  const linhas = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.from(tabela).select(select).range(offset, offset + PAGE - 1)
    if (error) throw error
    linhas.push(...data)
    if (data.length < PAGE) break
  }
  return linhas
}

async function main() {
  const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })

  // ─── 1. Raio-x dos devedores do legado (vencimento < hoje) ─────────────────
  const devedores = await buscarTodos(
    'contas_financeiras',
    'id, pessoa_nome, valor, vencimento, documento_ref, observacoes, pedido_id'
  )
  const emAtraso = devedores.filter((c) => c.vencimento < hoje)
  // Precisa filtrar tipo/status também — a query acima já trouxe tudo, filtra em memória:
  const { data: receberAbertas } = await supabase
    .from('contas_financeiras')
    .select('id')
    .eq('tipo', 'receber')
    .in('status', ['aberta', 'vencida'])
  const idsReceberAbertas = new Set((receberAbertas ?? []).map((c) => c.id))
  const devedoresLegado = emAtraso.filter((c) => idsReceberAbertas.has(c.id))

  const porCliente = new Map()
  for (const c of devedoresLegado) {
    const acc = porCliente.get(c.pessoa_nome) || { pessoa_nome: c.pessoa_nome, total: 0 }
    acc.total += Number(c.valor || 0)
    porCliente.set(c.pessoa_nome, acc)
  }

  const umDia = 24 * 60 * 60 * 1000
  const faixas = { d1_30: 0, d31_60: 0, d61_90: 0, d90_mais: 0 }
  let valorTotal = 0
  for (const c of devedoresLegado) {
    const dias = Math.floor((new Date(hoje) - new Date(c.vencimento)) / umDia)
    const valor = Number(c.valor || 0)
    valorTotal += valor
    if (dias <= 30) faixas.d1_30 += valor
    else if (dias <= 60) faixas.d31_60 += valor
    else if (dias <= 90) faixas.d61_90 += valor
    else faixas.d90_mais += valor
  }

  const top20 = [...porCliente.values()].sort((a, b) => b.total - a.total).slice(0, 20)

  console.log('═'.repeat(60))
  console.log('  RAIO-X DOS DEVEDORES (contas_financeiras, vencimento < hoje)')
  console.log('═'.repeat(60))
  console.log(`Total de títulos vencidos em aberto: ${devedoresLegado.length}`)
  console.log(`Total de devedores (clientes distintos): ${porCliente.size}`)
  console.log(`Valor total em aberto: ${fmtBRL(valorTotal)}`)
  console.log('\nDistribuição por faixa de atraso:')
  console.log(`  1-30 dias:  ${fmtBRL(faixas.d1_30)}`)
  console.log(`  31-60 dias: ${fmtBRL(faixas.d31_60)}`)
  console.log(`  61-90 dias: ${fmtBRL(faixas.d61_90)}`)
  console.log(`  +90 dias:   ${fmtBRL(faixas.d90_mais)}`)
  console.log('\nTop 20 maiores devedores:')
  top20.forEach((d, i) => console.log(`  ${i + 1}. ${d.pessoa_nome} — ${fmtBRL(d.total)}`))

  // ─── 2. Backfill de telefone_cobranca (auto-match por nome) ────────────────
  console.log('\n' + '═'.repeat(60))
  console.log('  BACKFILL DE TELEFONE (auto-match por nome)')
  console.log('═'.repeat(60))

  const clientesErp = await buscarTodos('clientes_erp', 'razao_social, nome_fantasia, contatos')
  const mapaPorNome = new Map()
  for (const cliente of clientesErp) {
    const telefone = (cliente.contatos ?? []).find((c) => TIPOS_TELEFONE.includes(c.tipo))?.valor
    if (!telefone) continue
    for (const nome of [cliente.razao_social, cliente.nome_fantasia]) {
      const chave = normalizar(nome)
      if (chave && !mapaPorNome.has(chave)) mapaPorNome.set(chave, telefone)
    }
  }

  // Todos os títulos abertos (não só vencidos) — telefone serve pra régua D-3 também.
  const { data: todosAbertos } = await supabase
    .from('contas_financeiras')
    .select('pessoa_nome')
    .eq('tipo', 'receber')
    .in('status', ['aberta', 'vencida'])
  const nomesDistintos = [...new Set((todosAbertos ?? []).map((c) => c.pessoa_nome).filter(Boolean))]

  let matches = 0
  for (const nome of nomesDistintos) {
    const telefone = mapaPorNome.get(normalizar(nome))
    if (!telefone) continue
    const { error } = await supabase
      .from('contas_financeiras')
      .update({ telefone_cobranca: telefone })
      .eq('pessoa_nome', nome)
      .eq('tipo', 'receber')
      .in('status', ['aberta', 'vencida'])
      .is('telefone_cobranca', null)
    if (error) throw error
    matches++
  }
  console.log(`Nomes distintos com título aberto: ${nomesDistintos.length}`)
  console.log(`Casados por nome e atualizados: ${matches} (${((matches / nomesDistintos.length) * 100).toFixed(1)}%)`)
  console.log(`Sem telefone (ficam editáveis na tela do Aging Report): ${nomesDistintos.length - matches}`)

  // ─── 3. Backfill de vendedor_id (só títulos com pedido_id) ─────────────────
  console.log('\n' + '═'.repeat(60))
  console.log('  BACKFILL DE VENDEDOR (só títulos vinculados a pedido)')
  console.log('═'.repeat(60))

  const { data: comPedido } = await supabase
    .from('contas_financeiras')
    .select('id, pedido_id')
    .not('pedido_id', 'is', null)
    .is('vendedor_id', null)

  let vendedorAtualizados = 0
  for (const conta of comPedido ?? []) {
    const { data: pedido } = await supabase.from('pedidos').select('vendedor_id').eq('id', conta.pedido_id).maybeSingle()
    if (!pedido?.vendedor_id) continue
    await supabase.from('contas_financeiras').update({ vendedor_id: pedido.vendedor_id }).eq('id', conta.id)
    vendedorAtualizados++
  }
  console.log(`Títulos com pedido_id e sem vendedor_id: ${comPedido?.length ?? 0}`)
  console.log(`Atualizados: ${vendedorAtualizados}`)
  console.log('\nConcluído.')
}

main().catch((err) => {
  console.error('ERRO:', err.message)
  process.exit(1)
})
