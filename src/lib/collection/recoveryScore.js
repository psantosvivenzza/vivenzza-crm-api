// FASE 4 — RECOVERY_SCORE (0-100), determinístico/explicável/auditável.
//
// Restrição do domínio real (auditoria): contas_financeiras NÃO tem FK para
// clientes_erp — o único identificador de "cliente" disponível de forma confiável
// em todos os títulos é `pessoa_nome` (texto). Este score usa pessoa_nome como
// chave de agregação (mesmo padrão já usado por disparar-individual em
// src/routes/cobrancas.js) — documentado aqui para não ser confundido com um
// cliente_id relacional que não existe hoje.
//
// Usa SOMENTE dados legítimos da relação financeira (histórico de pagamento,
// engajamento nas cobranças, promessas, atraso atual, tempo de relacionamento).
// NUNCA usa atributos sensíveis nem proxies (não há coleta de raça/religião/saúde/
// orientação sexual/opinião política neste sistema, e nenhum campo aqui se
// aproxima disso).
//
// Componente sem dado suficiente NÃO vira zero — recebe valor neutro (50% do peso
// máximo do componente) e é marcado `disponivel: false`, para não penalizar
// injustamente cliente novo/sem histórico.
import { supabase } from '../supabase-admin.server.js'
import { diasAtrasoDe } from './collectionContactPolicy.js'

export const FORMULA_VERSION = 'recovery_v1'

const PESO = {
  historico_pagamentos: 30,
  engajamento_cobranca: 20,
  comportamento_promessas: 20,
  dias_atraso: 15,
  relacionamento: 15,
}

function neutro(chave, motivo) {
  return { valor: Math.round(PESO[chave] * 0.5), maximo: PESO[chave], disponivel: false, detalhe: motivo }
}

async function componenteHistoricoPagamentos(pessoaNome) {
  const { data: titulos, error } = await supabase
    .from('contas_financeiras')
    .select('status')
    .eq('tipo', 'receber')
    .eq('pessoa_nome', pessoaNome)
  if (error) throw error
  if (!titulos?.length) return neutro('historico_pagamentos', 'sem histórico de títulos anteriores')

  const pagos = titulos.filter((t) => t.status === 'paga').length
  const proporcao = pagos / titulos.length
  return {
    valor: Math.round(PESO.historico_pagamentos * proporcao),
    maximo: PESO.historico_pagamentos,
    disponivel: true,
    detalhe: `${pagos}/${titulos.length} títulos pagos integralmente`,
  }
}

async function componenteEngajamento(pessoaNome) {
  const { data: envios, error } = await supabase
    .from('cobrancas_whatsapp')
    .select('status')
    .eq('cliente_nome', pessoaNome)
  if (error) throw error
  if (!envios?.length) return neutro('engajamento_cobranca', 'nenhuma cobrança enviada ainda')

  const respondeu = envios.filter((e) => ['respondida', 'paga'].includes(e.status)).length
  const proporcao = respondeu / envios.length
  return {
    valor: Math.round(PESO.engajamento_cobranca * proporcao),
    maximo: PESO.engajamento_cobranca,
    disponivel: true,
    detalhe: `respondeu a ${respondeu}/${envios.length} cobranças`,
  }
}

async function componentePromessas(pessoaNome) {
  const { data: promessas, error } = await supabase
    .from('collection_promises')
    .select('status')
    .eq('cliente_nome', pessoaNome)
    .in('status', ['cumprida', 'quebrada'])
  if (error) throw error
  if (!promessas?.length) return neutro('comportamento_promessas', 'sem histórico de promessas de pagamento')

  const cumpridas = promessas.filter((p) => p.status === 'cumprida').length
  const proporcao = cumpridas / promessas.length
  return {
    valor: Math.round(PESO.comportamento_promessas * proporcao),
    maximo: PESO.comportamento_promessas,
    disponivel: true,
    detalhe: `cumpriu ${cumpridas}/${promessas.length} promessas`,
  }
}

// Quanto mais atrasado o título ATUAL, menor a pontuação — escala linear de 0 a 60
// dias (acima disso, satura em 0 pontos). Título ainda não vencido (diasAtraso<=0)
// pontua o máximo.
function componenteDiasAtraso(diasAtraso) {
  if (diasAtraso <= 0) return { valor: PESO.dias_atraso, maximo: PESO.dias_atraso, disponivel: true, detalhe: 'título ainda não vencido' }
  const proporcao = Math.max(0, 1 - diasAtraso / 60)
  return {
    valor: Math.round(PESO.dias_atraso * proporcao),
    maximo: PESO.dias_atraso,
    disponivel: true,
    detalhe: `${diasAtraso} dia(s) de atraso`,
  }
}

// Tempo de relacionamento via clientes_erp, casado por codigo_cliente (legacy_id) —
// quando não há esse vínculo (título sem codigo_cliente preenchido, ou cliente sem
// registro em clientes_erp), usa valor neutro em vez de penalizar.
async function componenteRelacionamento(codigoCliente) {
  if (!codigoCliente) return neutro('relacionamento', 'título sem vínculo com cadastro de cliente (codigo_cliente ausente)')

  const { data: cliente, error } = await supabase
    .from('clientes_erp')
    .select('data_cadastro, data_ultima_compra')
    .eq('legacy_id', codigoCliente)
    .maybeSingle()
  if (error) throw error
  if (!cliente?.data_cadastro) return neutro('relacionamento', 'cliente sem data de cadastro conhecida')

  const anosDeRelacionamento = (Date.now() - new Date(cliente.data_cadastro)) / (365 * 24 * 60 * 60 * 1000)
  const proporcao = Math.min(1, anosDeRelacionamento / 3) // 3+ anos = pontuação máxima
  return {
    valor: Math.round(PESO.relacionamento * proporcao),
    maximo: PESO.relacionamento,
    disponivel: true,
    detalhe: `cliente há ${anosDeRelacionamento.toFixed(1)} ano(s)`,
  }
}

export async function calcularRecoveryScore(contasFinanceirasId) {
  const { data: titulo, error } = await supabase
    .from('contas_financeiras')
    .select('pessoa_nome, codigo_cliente, vencimento')
    .eq('id', contasFinanceirasId)
    .single()
  if (error) throw error

  const diasAtraso = diasAtrasoDe(titulo.vencimento)

  const componentes = {
    historico_pagamentos: await componenteHistoricoPagamentos(titulo.pessoa_nome),
    engajamento_cobranca: await componenteEngajamento(titulo.pessoa_nome),
    comportamento_promessas: await componentePromessas(titulo.pessoa_nome),
    dias_atraso: componenteDiasAtraso(diasAtraso),
    relacionamento: await componenteRelacionamento(titulo.codigo_cliente),
  }

  const score = Object.values(componentes).reduce((soma, c) => soma + c.valor, 0)
  const explicacao = Object.entries(componentes)
    .map(([chave, c]) => `${chave}: ${c.valor}/${c.maximo} (${c.detalhe}${c.disponivel ? '' : ' — valor neutro, dado insuficiente'})`)
    .join('; ')

  return { score: Math.max(0, Math.min(100, score)), componentes, explicacao }
}

// 2026-08-15 — upsert por conta (não insert), mesmo racional de
// priorityScore.js:calcularEPersistirPriorityScore — score "atual", não
// histórico, índice único em contas_financeiras_id.
export async function calcularEPersistirRecoveryScore(contasFinanceirasId) {
  const { score, componentes, explicacao } = await calcularRecoveryScore(contasFinanceirasId)
  const { data, error } = await supabase
    .from('collection_recovery_scores')
    .upsert(
      { contas_financeiras_id: contasFinanceirasId, score, formula_version: FORMULA_VERSION, componentes, explicacao, calculado_em: new Date().toISOString() },
      { onConflict: 'contas_financeiras_id' }
    )
    .select()
    .single()
  if (error) throw error
  return data
}

export async function ultimoRecoveryScore(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('collection_recovery_scores')
    .select('*')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .order('calculado_em', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data
}
