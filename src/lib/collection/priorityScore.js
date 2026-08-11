// FASE 4 — COLLECTION_PRIORITY_SCORE (0-100): onde gastar esforço de cobrança
// agora, não "quão recuperável é este cliente no geral" (isso é o RECOVERY_SCORE).
// Determinístico, explicável, versionado — mesmo padrão de recoveryScore.js.
//
// Valor da dívida NUNCA é usado como número absoluto ingênuo (pedido explícito:
// "R$ 500 não deve receber sempre o mesmo peso independentemente da realidade da
// empresa") — é normalizado pelo PERCENTIL do saldo devedor dentro da carteira real
// de títulos em aberto no momento do cálculo.
import { supabase } from '../supabase-admin.server.js'
import { diasAtrasoDe } from './collectionContactPolicy.js'

export const FORMULA_VERSION = 'priority_v1'

const PESO = {
  valor_divida: 35,
  dias_atraso: 20,
  recuperabilidade: 25,
  promessa_quebrada: 10,
  interacao_recente: 10,
}

// FASE B.5 (homologação, 2026-08-11) — achado de performance da B.1.1 (rodada
// real levou ~2,6s/conta, ~131s para 50 contas): esta função varria a carteira
// inteira do zero A CADA conta. `carregarDistribuicaoSaldos()` faz essa
// varredura só 1x por batch; `percentilEmDistribuicao()` reusa o array já
// ordenado via busca binária (O(log n) por conta, em vez de outra varredura
// completa). `percentilNaCarteira()` continua existindo — comportamento
// idêntico a antes — para não quebrar nenhum chamador que rode 1 conta isolada
// (ex: recalcular score de 1 título específico não justifica pré-carregar a
// carteira toda).
export async function carregarDistribuicaoSaldos() {
  const saldos = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from('contas_financeiras')
      .select('valor, valor_pago')
      .eq('tipo', 'receber')
      .in('status', ['aberta', 'vencida', 'pago_parcial'])
      .range(offset, offset + PAGE - 1)
    if (error) throw error
    for (const c of data ?? []) {
      const saldo = Number(c.valor || 0) - Number(c.valor_pago || 0)
      if (saldo > 0) saldos.push(saldo)
    }
    if ((data?.length ?? 0) < PAGE) break
  }
  saldos.sort((a, b) => a - b)
  return saldos
}

// Busca binária pela última posição com saldo <= saldoAlvo — equivalente a
// `saldos.filter(s => s <= saldoAlvo).length` no array JÁ ORDENADO, sem
// percorrer tudo de novo.
export function percentilEmDistribuicao(saldoAlvo, saldosOrdenados) {
  if (!saldosOrdenados.length) return 0.5
  let lo = 0
  let hi = saldosOrdenados.length
  while (lo < hi) {
    const meio = (lo + hi) >> 1
    if (saldosOrdenados[meio] <= saldoAlvo) lo = meio + 1
    else hi = meio
  }
  return lo / saldosOrdenados.length // 0..1
}

async function percentilNaCarteira(saldoAlvo) {
  const saldos = await carregarDistribuicaoSaldos()
  return percentilEmDistribuicao(saldoAlvo, saldos)
}

function componenteDiasAtraso(diasAtraso) {
  // Quanto mais atrasado, maior a prioridade — mas satura em 90 dias (depois disso
  // já é etapa 8 da régua; mais atraso não aumenta mais a urgência relativa).
  const proporcao = Math.max(0, Math.min(1, diasAtraso / 90))
  return { valor: Math.round(PESO.dias_atraso * proporcao), maximo: PESO.dias_atraso, detalhe: `${diasAtraso} dia(s) de atraso` }
}

async function componentePromessaQuebrada(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('collection_promises')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .eq('status', 'quebrada')
    .limit(1)
  if (error) throw error
  const teve = (data?.length ?? 0) > 0
  return { valor: teve ? PESO.promessa_quebrada : 0, maximo: PESO.promessa_quebrada, detalhe: teve ? 'teve promessa quebrada' : 'sem promessa quebrada' }
}

async function componenteInteracaoRecente(contasFinanceirasId) {
  const seteDiasAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('collection_timeline_events')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .eq('tipo', 'RESPONDEU')
    .gte('criado_em', seteDiasAtras)
    .limit(1)
  if (error) throw error
  const engajouRecente = (data?.length ?? 0) > 0
  return {
    valor: engajouRecente ? PESO.interacao_recente : 0,
    maximo: PESO.interacao_recente,
    detalhe: engajouRecente ? 'respondeu nos últimos 7 dias' : 'sem resposta recente',
  }
}

export async function calcularPriorityScore(contasFinanceirasId, { recoveryScore = null, distribuicaoSaldos = null } = {}) {
  const { data: titulo, error } = await supabase
    .from('contas_financeiras')
    .select('valor, valor_pago, vencimento')
    .eq('id', contasFinanceirasId)
    .single()
  if (error) throw error

  const saldo = Number(titulo.valor || 0) - Number(titulo.valor_pago || 0)
  const diasAtraso = diasAtrasoDe(titulo.vencimento)
  // Batch (carteira inteira, ex: simulação B.5) passa distribuicaoSaldos
  // pré-carregada 1x; chamada isolada (1 conta) continua escaneando sob
  // demanda, comportamento idêntico a antes desta otimização.
  const percentil = distribuicaoSaldos ? percentilEmDistribuicao(saldo, distribuicaoSaldos) : await percentilNaCarteira(saldo)

  const componenteValor = {
    valor: Math.round(PESO.valor_divida * percentil),
    maximo: PESO.valor_divida,
    detalhe: `saldo R$ ${saldo.toFixed(2)} está no percentil ${Math.round(percentil * 100)} da carteira em aberto`,
  }

  // Recuperabilidade: reaproveita o recoveryScore já calculado (0-100) se fornecido
  // — evita recalcular os 5 componentes de recoveryScore de novo; se não fornecido,
  // usa valor neutro (50%) em vez de forçar um cálculo caro aqui.
  const proporcaoRecuperabilidade = recoveryScore != null ? recoveryScore / 100 : 0.5
  const componenteRecuperabilidade = {
    valor: Math.round(PESO.recuperabilidade * proporcaoRecuperabilidade),
    maximo: PESO.recuperabilidade,
    detalhe: recoveryScore != null ? `recovery_score=${recoveryScore}` : 'recovery_score não fornecido — valor neutro',
  }

  const componentes = {
    valor_divida: componenteValor,
    dias_atraso: componenteDiasAtraso(diasAtraso),
    recuperabilidade: componenteRecuperabilidade,
    promessa_quebrada: await componentePromessaQuebrada(contasFinanceirasId),
    interacao_recente: await componenteInteracaoRecente(contasFinanceirasId),
  }

  const score = Object.values(componentes).reduce((soma, c) => soma + c.valor, 0)
  const explicacao = Object.entries(componentes).map(([chave, c]) => `${chave}: ${c.valor}/${c.maximo} (${c.detalhe})`).join('; ')

  return { score: Math.max(0, Math.min(100, score)), componentes, explicacao }
}

export async function calcularEPersistirPriorityScore(contasFinanceirasId, opts) {
  const { score, componentes, explicacao } = await calcularPriorityScore(contasFinanceirasId, opts)
  const { data, error } = await supabase
    .from('collection_priority_scores')
    .insert({ contas_financeiras_id: contasFinanceirasId, score, formula_version: FORMULA_VERSION, componentes, explicacao })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function ultimoPriorityScore(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('collection_priority_scores')
    .select('*')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .order('calculado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}
