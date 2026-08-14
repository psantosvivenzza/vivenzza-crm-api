/**
 * Auditoria READ-ONLY — DOMÍNIO B: FATURAMENTO FISCAL (notas de venda).
 *
 * Renomeado de audit-netvision-vendas.mjs: esse nome misturava dois domínios
 * diferentes (pedido comercial vs nota fiscal emitida). Ver
 * audit-netvision-pedidos.mjs pro domínio A (PEDIDOS COMERCIAIS,
 * pedido↔pedido, match exato por legacy_id — isso é o espelhamento
 * ES_Pedidos→pedidos, quase 1:1 por construção).
 *
 * Este script (domínio B) tenta casar pedido "faturado" no Vivenzza com a(s)
 * nota(s) fiscal(is) reais no NetVision (`EN_Notas`, TipoNota='VEN'). Vivenzza
 * NÃO tem uma entidade própria de nota fiscal populada (`pedidos.numero_nfe`/
 * `nfe_id` ficam NULL nos dados reais verificados) — então a comparação é
 * sempre "pedido Vivenzza" vs "nota NetVision", nunca "nota vs nota".
 *
 * ACHADO METODOLÓGICO 1 (2026-08-14): `EN_Notas."NumeroPedido"` é sempre 0
 * no período testado — não é FK utilizável (confirmado por amostra e por
 * investigação mais ampla no schema, ver relatório da auditoria). Não existe
 * vínculo de ID confiável pedido→nota nos dados reais.
 *
 * ACHADO METODOLÓGICO 2: `EN_Notas."Cliente"` bate exatamente com
 * `pedidos.cliente_externo_id` (mesmo código) — dá pra identificar O CLIENTE
 * com certeza, mas não a nota específica. Todo pareamento pedido↔nota aqui é
 * portanto HEURÍSTICO (cliente + valor, ou cliente + data), nunca tratado
 * como vínculo definitivo — cada linha carrega match_method/match_confidence
 * explícitos.
 *
 * ACHADO METODOLÓGICO 3 (faturamento parcial): quando um pedido não bate
 * com nenhuma nota no período estreito, o script agora busca — só pro
 * cliente daquele pedido específico, numa janela mais larga (-5/+45 dias) —
 * se existem notas ativas cuja soma seja MENOR que o total do pedido. Se
 * sim: PARTIAL_INVOICING (não é erro financeiro, é o pedido ainda não ter
 * sido 100% faturado). Se a soma bater com o total do pedido dentro da
 * janela larga (só que dividida em >1 nota, ou emitida fora da janela
 * estreita): reclassifica pra LEGACY_VALID. Se não achar nenhuma nota:
 * mantém EXTRA_IN_VIVENZZA.
 *
 *   node scripts/audit-netvision-faturamento.mjs [--from=] [--to=] [--json=] [--csv=]
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
const JANELA_DATA_DIAS = 6
const JANELA_PARCIAL_ANTES_DIAS = 5
const JANELA_PARCIAL_DEPOIS_DIAS = 45

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
const SAIDA_CSV = argValor('csv', null)

function dataISO(v) { return v ? (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)) : null }
function diasEntre(a, b) {
  const da = new Date(dataISO(a)), db = new Date(dataISO(b))
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return Infinity
  return Math.abs((da.getTime() - db.getTime()) / 86400000)
}
function somarDias(dataStr, dias) {
  const d = new Date(dataStr); d.setUTCDate(d.getUTCDate() + dias); return d.toISOString().slice(0, 10)
}

let pool
function poolE01() {
  if (!pool) {
    const faltando = ['E01_HOST', 'E01_PORT', 'E01_USER', 'E01_DATABASE'].filter((v) => !process.env[v])
    if (faltando.length) throw new Error(`Variáveis de ambiente E01 ausentes: ${faltando.join(', ')}`)
    pool = new pg.Pool({ host: process.env.E01_HOST, port: process.env.E01_PORT, user: process.env.E01_USER, password: process.env.E01_PASSWORD, database: process.env.E01_DATABASE })
  }
  return pool
}

async function buscarNetVision() {
  const { rows } = await poolE01().query(
    `SELECT "CodigoFilial", "NumeroNota", "Cliente", "DataEmissao", "ValorNota", "ValorTotalProdutos", "Cancelada"
     FROM "EN_Notas"
     WHERE "TipoNota" = 'VEN' AND "DataEmissao" >= $1 AND "DataEmissao" < ($2::date + interval '1 day')
     ORDER BY "CodigoFilial", "Cliente", "NumeroNota"`,
    [DE, ATE]
  )
  return rows.map((r) => ({ ...r, Cliente: (r.Cliente || '').trim(), ValorNota: Number(r.ValorNota), ValorTotalProdutos: Number(r.ValorTotalProdutos) }))
}

async function buscarNotasClienteJanelaLarga(clienteCod, dataBase) {
  const de = somarDias(dataISO(dataBase), -JANELA_PARCIAL_ANTES_DIAS)
  const ate = somarDias(dataISO(dataBase), JANELA_PARCIAL_DEPOIS_DIAS)
  const { rows } = await poolE01().query(
    `SELECT "NumeroNota", "DataEmissao", "ValorNota", "Cancelada" FROM "EN_Notas"
     WHERE "TipoNota"='VEN' AND "Cliente"=$1 AND "DataEmissao" >= $2 AND "DataEmissao" < ($3::date + interval '1 day')
     ORDER BY "NumeroNota"`,
    [clienteCod.padEnd(10), de, ate]
  )
  return rows.map((r) => ({ ...r, ValorNota: Number(r.ValorNota) }))
}

async function buscarVivenzza() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY)
  const linhas = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('pedidos')
      .select('id, legacy_id, status, total, desconto, valor_frete, criado_em, sistema_origem, cliente_externo_id')
      .gte('criado_em', `${DE}T00:00:00Z`)
      .lt('criado_em', `${ATE}T23:59:59.999Z`)
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    linhas.push(...data)
    if (data.length < PAGE) break
  }
  return linhas
}

function agruparPorCliente(notas, pedidos) {
  const clientes = new Map()
  for (const n of notas) {
    if (!n.Cliente) continue
    if (!clientes.has(n.Cliente)) clientes.set(n.Cliente, { notas: [], pedidos: [] })
    clientes.get(n.Cliente).notas.push(n)
  }
  const semClienteVivenzza = []
  for (const p of pedidos) {
    const cod = (p.cliente_externo_id || '').trim()
    if (!cod || p.sistema_origem !== 'legado') { semClienteVivenzza.push(p); continue }
    if (!clientes.has(cod)) clientes.set(cod, { notas: [], pedidos: [] })
    clientes.get(cod).pedidos.push(p)
  }
  return { clientes, semClienteVivenzza }
}

function classificarPar(pedido, nota, metodo, confianca) {
  const notaCancelada = Number(nota.Cancelada) !== 0
  const pedidoValido = pedido.status === 'faturado'
  if (pedidoValido && notaCancelada) return { categoria: 'STATUS_MISMATCH', deltaReais: Number(pedido.total || 0), match_method: metodo, match_confidence: confianca, obs: `Vivenzza=faturado, NetVision nota ${nota.NumeroNota} Cancelada=${nota.Cancelada}` }
  if (!pedidoValido && !notaCancelada) return { categoria: 'STATUS_MISMATCH', deltaReais: -Number(nota.ValorNota || 0), match_method: metodo, match_confidence: confianca, obs: `Vivenzza status=${pedido.status}, NetVision nota ${nota.NumeroNota} ativa` }
  if (!pedidoValido && notaCancelada) return { categoria: 'LEGACY_VALID', deltaReais: 0, match_method: metodo, match_confidence: confianca, obs: 'ambos concordam que não é venda válida' }
  const totalVivenzza = Number(pedido.total || 0)
  const diffValorNota = totalVivenzza - nota.ValorNota
  const diffValorProdutos = totalVivenzza - nota.ValorTotalProdutos
  const dataDivergente = diasEntre(pedido.criado_em, nota.DataEmissao) > 0
  if (Math.abs(diffValorNota) <= TOLERANCIA_CENTAVOS) {
    if (dataDivergente) return { categoria: 'DATE_MISMATCH', deltaReais: 0, match_method: metodo, match_confidence: confianca, obs: `criado_em=${dataISO(pedido.criado_em)} vs DataEmissao=${dataISO(nota.DataEmissao)} (nota ${nota.NumeroNota})` }
    return { categoria: 'LEGACY_VALID', deltaReais: 0, match_method: metodo, match_confidence: confianca }
  }
  if (Math.abs(diffValorProdutos) <= TOLERANCIA_CENTAVOS) return { categoria: 'TRANSFORMATION_MISMATCH', deltaReais: diffValorNota, match_method: metodo, match_confidence: confianca, obs: `bate com ValorTotalProdutos (R$${nota.ValorTotalProdutos.toFixed(2)}) não com ValorNota (R$${nota.ValorNota.toFixed(2)}) — nota ${nota.NumeroNota}` }
  return { categoria: 'VALUE_MISMATCH', deltaReais: diffValorNota, match_method: metodo, match_confidence: confianca, obs: `Vivenzza total=R$${totalVivenzza.toFixed(2)} vs NetVision ValorNota=R$${nota.ValorNota.toFixed(2)} (nota ${nota.NumeroNota})` }
}

async function classificarPedidoSemPar(pedido) {
  if (pedido.status !== 'faturado') return { categoria: 'LEGACY_VALID', deltaReais: 0, match_method: 'sem_par', match_confidence: 'N/A', obs: `pedido não faturado (${pedido.status}) sem contrapartida — esperado` }
  const cod = (pedido.cliente_externo_id || '').trim()
  if (!cod) return { categoria: 'UNKNOWN', deltaReais: Number(pedido.total || 0), match_method: 'sem_par', match_confidence: 'N/A', obs: 'cliente_externo_id ausente, não dá pra buscar nota' }

  const notasJanelaLarga = await buscarNotasClienteJanelaLarga(cod, pedido.criado_em)
  const ativas = notasJanelaLarga.filter((n) => Number(n.Cancelada) === 0)
  const somaAtivas = ativas.reduce((s, n) => s + n.ValorNota, 0)
  const totalPedido = Number(pedido.total || 0)

  if (ativas.length === 0) {
    return { categoria: 'EXTRA_IN_VIVENZZA', deltaReais: totalPedido, match_method: 'sem_par', match_confidence: 'N/A', obs: `nenhuma nota ativa do cliente ${cod} entre ${JANELA_PARCIAL_ANTES_DIAS}d antes e ${JANELA_PARCIAL_DEPOIS_DIAS}d depois — não faturado no NetVision nessa janela` }
  }
  // notas usadas na reclassificação que caem FORA da janela estreita [DE,ATE]
  // não estavam contadas em total_netvision_ativo — precisa somar à parte pra
  // reconciliar a checagem de sanidade (ver main()).
  const foraDaJanelaEstreita = ativas.filter((n) => dataISO(n.DataEmissao) < DE || dataISO(n.DataEmissao) > ATE).reduce((s, n) => s + n.ValorNota, 0)

  if (Math.abs(somaAtivas - totalPedido) <= TOLERANCIA_CENTAVOS) {
    return { categoria: 'LEGACY_VALID', deltaReais: totalPedido - foraDaJanelaEstreita, valor_fora_da_janela_estreita: foraDaJanelaEstreita, match_method: 'HEURISTIC_CLIENT_VALUE', match_confidence: 'HEURISTIC', obs: `soma de ${ativas.length} nota(s) na janela larga bate com o pedido — faturado em partes, fora da janela estreita: [${ativas.map((n) => `${n.NumeroNota}=R$${n.ValorNota.toFixed(2)}`).join(', ')}]` }
  }
  if (somaAtivas < totalPedido) {
    return {
      categoria: 'PARTIAL_INVOICING', deltaReais: totalPedido - somaAtivas - foraDaJanelaEstreita, valor_fora_da_janela_estreita: foraDaJanelaEstreita,
      match_method: 'HEURISTIC_CLIENT_VALUE', match_confidence: 'HEURISTIC',
      pedido_total: Number(totalPedido.toFixed(2)), valor_faturado_acumulado: Number(somaAtivas.toFixed(2)), saldo_a_faturar: Number((totalPedido - somaAtivas).toFixed(2)),
      obs: `notas ativas na janela larga: [${ativas.map((n) => `${n.NumeroNota}=R$${n.ValorNota.toFixed(2)} (${dataISO(n.DataEmissao)})`).join(', ')}]`,
    }
  }
  // somaAtivas > totalPedido — soma passa do pedido, não é parcial "normal"; reporta como VALUE_MISMATCH honesto em vez de forçar categoria
  return { categoria: 'VALUE_MISMATCH', deltaReais: totalPedido - somaAtivas - foraDaJanelaEstreita, valor_fora_da_janela_estreita: foraDaJanelaEstreita, match_method: 'HEURISTIC_CLIENT_VALUE', match_confidence: 'HEURISTIC', obs: `soma de notas ativas (R$${somaAtivas.toFixed(2)}) excede o total do pedido (R$${totalPedido.toFixed(2)}) — possível nota de outro pedido do mesmo cliente na janela` }
}

function parearCliente(cod, notas, pedidos) {
  const usadasNotas = new Set(), usadosPedidos = new Set()
  const linhas = []
  for (let pi = 0; pi < pedidos.length; pi++) {
    let melhorIdx = -1, melhorScore = Infinity
    for (let ni = 0; ni < notas.length; ni++) {
      if (usadasNotas.has(ni)) continue
      const diffValor = Math.abs(Number(pedidos[pi].total || 0) - notas[ni].ValorNota)
      if (diffValor > TOLERANCIA_CENTAVOS) continue
      const statusCongruente = (pedidos[pi].status === 'faturado') === (Number(notas[ni].Cancelada) === 0)
      const score = (statusCongruente ? 0 : 1000) + diasEntre(pedidos[pi].criado_em, notas[ni].DataEmissao)
      if (score < melhorScore) { melhorScore = score; melhorIdx = ni }
    }
    if (melhorIdx >= 0) {
      usadosPedidos.add(pi); usadasNotas.add(melhorIdx)
      linhas.push({ chave: `cliente-${cod}-nota${notas[melhorIdx].NumeroNota}`, ...classificarPar(pedidos[pi], notas[melhorIdx], 'HEURISTIC_CLIENT_VALUE', 'HEURISTIC') })
    }
  }
  const pedidosSobra = pedidos.map((_, i) => i).filter((i) => !usadosPedidos.has(i))
  const notasSobra = notas.map((_, i) => i).filter((i) => !usadasNotas.has(i))
  if (pedidosSobra.length === 1 && notasSobra.length === 1) {
    const pi = pedidosSobra[0], ni = notasSobra[0]
    if (diasEntre(pedidos[pi].criado_em, notas[ni].DataEmissao) <= JANELA_DATA_DIAS) {
      usadosPedidos.add(pi); usadasNotas.add(ni)
      linhas.push({ chave: `cliente-${cod}-nota${notas[ni].NumeroNota}`, ...classificarPar(pedidos[pi], notas[ni], 'HEURISTIC_CLIENT_DATE', 'HEURISTIC') })
    }
  }
  const pedidosLeftover = pedidos.map((_, i) => i).filter((i) => !usadosPedidos.has(i)).map((i) => pedidos[i])
  const notasLeftover = notas.map((_, i) => i).filter((i) => !usadasNotas.has(i)).map((i) => notas[i])
  return { linhas, pedidosLeftover, notasLeftover, cod }
}

function somaTotal(pedidos) { return pedidos.reduce((s, p) => s + Number(p.total || 0), 0) }
function somaValorNota(notas) { return notas.reduce((s, n) => s + n.ValorNota, 0) }

async function main() {
  console.log(`[audit:netvision:faturamento] DOMÍNIO B — FATURAMENTO FISCAL. Período ${DE}..${ATE}`)
  console.log('  (pedido Vivenzza "faturado" vs nota fiscal NetVision — SEM entidade de NF própria no Vivenzza; pareamento é sempre heurístico, nunca por ID)')

  const [netvisionRows, vivenzzaRows] = await Promise.all([buscarNetVision(), buscarVivenzza()])

  const totalVivenzzaFaturado = somaTotal(vivenzzaRows.filter((p) => p.status === 'faturado'))
  const totalNetVisionAtivo = somaValorNota(netvisionRows.filter((n) => Number(n.Cancelada) === 0))
  console.log(`  Vivenzza (pedidos.status='faturado'): R$ ${totalVivenzzaFaturado.toFixed(2)}`)
  console.log(`  NetVision (EN_Notas TipoNota='VEN', Cancelada=0, mesmo período): R$ ${totalNetVisionAtivo.toFixed(2)}`)
  console.log(`  Delta bruto: R$ ${(totalVivenzzaFaturado - totalNetVisionAtivo).toFixed(2)} — NÃO é "o erro"; grande parte é faturamento parcial legítimo (ver PARTIAL_INVOICING abaixo)`)

  const { clientes, semClienteVivenzza } = agruparPorCliente(netvisionRows, vivenzzaRows)

  const linhas = []
  const todosLeftoverPedidos = []
  for (const [cod, g] of clientes) {
    const r = parearCliente(cod, g.notas, g.pedidos)
    linhas.push(...r.linhas)
    for (const p of r.pedidosLeftover) todosLeftoverPedidos.push(p)
    for (const n of r.notasLeftover) linhas.push({ chave: `cliente-${cod}-nota${n.NumeroNota}`, categoria: Number(n.Cancelada) === 0 ? 'MISSING_IN_VIVENZZA' : 'LEGACY_VALID', deltaReais: Number(n.Cancelada) === 0 ? -n.ValorNota : 0, match_method: 'sem_par', match_confidence: 'N/A', obs: Number(n.Cancelada) === 0 ? `nota ${n.NumeroNota} ativa sem pedido correspondente` : 'nota cancelada sem contrapartida' })
  }
  for (const p of semClienteVivenzza) {
    linhas.push({ chave: `pedido-vivenzza-${p.id}`, categoria: p.sistema_origem !== 'legado' ? 'EXTRA_IN_VIVENZZA' : 'UNKNOWN', deltaReais: p.status === 'faturado' ? Number(p.total || 0) : 0, match_method: 'sem_par', match_confidence: 'N/A', obs: p.sistema_origem !== 'legado' ? `sistema_origem=${p.sistema_origem}` : `cliente_externo_id ausente (legacy_id=${p.legacy_id})` })
  }

  console.log(`\n  Reconciliação de faturamento parcial: consultando janela larga (-${JANELA_PARCIAL_ANTES_DIAS}d/+${JANELA_PARCIAL_DEPOIS_DIAS}d) pra ${todosLeftoverPedidos.length} pedido(s) sem par na janela estreita...`)
  for (const p of todosLeftoverPedidos) {
    const c = await classificarPedidoSemPar(p)
    linhas.push({ chave: `cliente-${(p.cliente_externo_id || '').trim()}-pedido${p.legacy_id}`, ...c })
  }

  const porCategoria = {}
  for (const l of linhas) {
    if (!porCategoria[l.categoria]) porCategoria[l.categoria] = { count: 0, deltaReais: 0, exemplos: [] }
    porCategoria[l.categoria].count++
    porCategoria[l.categoria].deltaReais += l.deltaReais
    if (porCategoria[l.categoria].exemplos.length < 10) porCategoria[l.categoria].exemplos.push(l)
  }

  console.log('\n  Decomposição por categoria (domínio FATURAMENTO FISCAL):')
  const CATEGORIAS = ['MISSING_IN_VIVENZZA', 'EXTRA_IN_VIVENZZA', 'VALUE_MISMATCH', 'STATUS_MISMATCH', 'DATE_MISMATCH', 'DUPLICATE', 'TRANSFORMATION_MISMATCH', 'PARTIAL_INVOICING', 'LEGACY_VALID', 'UNKNOWN']
  for (const cat of CATEGORIAS) {
    const c = porCategoria[cat] || { count: 0, deltaReais: 0 }
    console.log(`    ${cat.padEnd(24)} n=${String(c.count).padStart(4)}  delta=R$ ${c.deltaReais.toFixed(2)}`)
  }
  const partial = porCategoria.PARTIAL_INVOICING || { count: 0, exemplos: [] }
  const somaFaturadoParcial = partial.exemplos.reduce((s, l) => s + (l.valor_faturado_acumulado || 0), 0)
  const somaSaldoParcial = partial.exemplos.reduce((s, l) => s + (l.saldo_a_faturar || 0), 0)
  const somaTotalParcial = partial.exemplos.reduce((s, l) => s + (l.pedido_total || 0), 0)
  console.log(`  PARTIAL_INVOICING (${partial.count} pedidos, exemplos capturados=${partial.exemplos.length}): pedido_total=R$${somaTotalParcial.toFixed(2)} faturado=R$${somaFaturadoParcial.toFixed(2)} saldo_a_faturar=R$${somaSaldoParcial.toFixed(2)}`)

  const porMetodo = {}
  for (const l of linhas) porMetodo[l.match_method] = (porMetodo[l.match_method] || 0) + 1
  console.log('  Método de pareamento:', JSON.stringify(porMetodo))

  // Checagem de sanidade real: como o pareamento de PARTIAL_INVOICING/LEGACY_VALID
  // usa notas de uma janela LARGA (que pode extrapolar [DE,ATE]), a soma das
  // categorias só bate com (total_vivenzza_faturado - total_netvision_ativo) se
  // ajustarmos o total NetVision pra incluir o que foi usado fora da janela
  // estreita (campo valor_fora_da_janela_estreita, já registrado por linha).
  const valorForaDaJanela = linhas.reduce((s, l) => s + (l.valor_fora_da_janela_estreita || 0), 0)
  const totalNetVisionConsiderado = totalNetVisionAtivo + valorForaDaJanela
  const deltaConsiderado = totalVivenzzaFaturado - totalNetVisionConsiderado
  const somaCategorias = linhas.reduce((s, l) => s + l.deltaReais, 0)
  const gapChecagem = Math.abs(somaCategorias - deltaConsiderado)
  console.log(`\n  Checagem de sanidade: NetVision ativo no período=R$${totalNetVisionAtivo.toFixed(2)} + usado fora da janela (parcial)=R$${valorForaDaJanela.toFixed(2)} = R$${totalNetVisionConsiderado.toFixed(2)}`)
  console.log(`  Delta considerado = R$${deltaConsiderado.toFixed(2)}  |  Soma das categorias = R$${somaCategorias.toFixed(2)}  |  gap não explicado = R$${gapChecagem.toFixed(2)}`)
  if (gapChecagem > TOLERANCIA_CENTAVOS) {
    console.log(`  ⚠ NÃO fecha 1:1 — isso é ESPERADO neste domínio heurístico, não um bug silencioso: uma nota "sem par" na janela estreita (contada em MISSING_IN_VIVENZZA) pode reaparecer na busca de janela larga de um pedido diferente do mesmo cliente (risco de reuso/dupla-contagem entre linhas). Por isso este domínio é só EVIDÊNCIA INVESTIGATIVA — a decomposição confiável e fechada é a do domínio A (pedido×pedido, audit-netvision-pedidos.mjs, match exato). Não tratar MISSING/EXTRA/VALUE_MISMATCH aqui como gap contábil definitivo (ver match_confidence=HEURISTIC em cada linha).`)
  }

  const resultado = {
    dominio: 'FATURAMENTO_FISCAL', periodo: { de: DE, ate: ATE },
    aviso: 'Vivenzza TEM uma entidade de nota fiscal própria (`public.nfe`, 10.588 linhas, com nfe_itens/nfe_eventos e serviço completo de emissão SEFAZ em src/services/nfe/) mas ela não está em uso real: 100% das linhas têm pedido_id=NULL, só 1 nota foi autorizada de verdade (parece teste), 0 eventos no log de auditoria, e a emissão série 1 está travada por configuracoes_fiscais.serie1_numeracao_liberada=false (gate deliberado, aguardando validação contábil da numeração legada). As 10.588 linhas existentes são import histórico do NetVision (view notas_legado_unificado: serie 99=vendas_legado, serie 1=NF reais antigas), não faturamento corrente. Por isso esta comparação usa pedido(Vivenzza) x nota(NetVision ao vivo), nunca nota-própria x nota — Vivenzza não fatura por conta própria hoje. Ver GAP FISCAL_INVOICING_NOT_MIRRORED no checklist de retirement readiness.',
    total_vivenzza_faturado: Number(totalVivenzzaFaturado.toFixed(2)),
    total_netvision_ativo_no_periodo: Number(totalNetVisionAtivo.toFixed(2)),
    total_netvision_considerado_incl_janela_larga: Number(totalNetVisionConsiderado.toFixed(2)),
    delta_bruto_periodo_a_periodo: Number((totalVivenzzaFaturado - totalNetVisionAtivo).toFixed(2)),
    delta_considerado_apos_reconciliacao: Number(deltaConsiderado.toFixed(2)),
    soma_categorias: Number(somaCategorias.toFixed(2)),
    gap_checagem_sanidade: Number(gapChecagem.toFixed(2)),
    partial_invoicing_resumo: { pedidos: partial.count, pedido_total: Number(somaTotalParcial.toFixed(2)), valor_faturado_acumulado: Number(somaFaturadoParcial.toFixed(2)), saldo_a_faturar: Number(somaSaldoParcial.toFixed(2)) },
    por_metodo_pareamento: porMetodo,
    por_categoria: Object.fromEntries(CATEGORIAS.map((c) => [c, porCategoria[c] || { count: 0, deltaReais: 0, exemplos: [] }])),
    linhas,
  }
  if (SAIDA_JSON) { fs.writeFileSync(SAIDA_JSON, JSON.stringify(resultado, null, 2)); console.log(`\n  JSON salvo em ${SAIDA_JSON}`) }
  if (SAIDA_CSV) {
    const header = 'chave,categoria,deltaReais,match_method,match_confidence,pedido_total,valor_faturado_acumulado,saldo_a_faturar,obs\n'
    const corpo = linhas.map((l) => `${l.chave},${l.categoria},${l.deltaReais.toFixed(2)},${l.match_method},${l.match_confidence},${l.pedido_total ?? ''},${l.valor_faturado_acumulado ?? ''},${l.saldo_a_faturar ?? ''},"${(l.obs || '').replace(/"/g, "'")}"`).join('\n')
    fs.writeFileSync(SAIDA_CSV, header + corpo)
    console.log(`  CSV salvo em ${SAIDA_CSV}`)
  }
  if (pool) await pool.end()
  process.exit(0)
}

main().catch((err) => { console.error('[audit:netvision:faturamento] ERRO:', err.message); process.exit(2) })
