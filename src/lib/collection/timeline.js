// Timeline única de interações (cliente + título + interações). Toda ação do motor
// de cobrança v2 registra um evento aqui, sempre com origem explícita — é a base do
// "10/08 08:15 WhatsApp enviado / 08:15 entregue / 08:20 cliente respondeu..." pedido.
import { supabase } from '../supabase-admin.server.js'

export const ORIGEM = Object.freeze({
  AUTOMATION: 'AUTOMATION',
  AI: 'AI',
  HUMAN: 'HUMAN',
  SYSTEM: 'SYSTEM',
  PAYMENT_RECONCILIATION: 'PAYMENT_RECONCILIATION',
})

export async function registrarEvento({ contasFinanceirasId, clienteTelefone = null, tipo, origem, canal = null, descricao, dados = null, criadoPor = null }) {
  if (!Object.values(ORIGEM).includes(origem)) {
    throw new Error(`Origem de evento inválida: ${origem}`)
  }
  const { data, error } = await supabase
    .from('collection_timeline_events')
    .insert({
      contas_financeiras_id: contasFinanceirasId,
      cliente_telefone: clienteTelefone,
      tipo,
      origem,
      canal,
      descricao,
      dados,
      criado_por: criadoPor,
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function timelineDoTitulo(contasFinanceirasId, { limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('collection_timeline_events')
    .select('*')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .order('criado_em', { ascending: true })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

// Versão paginada, usada só pelo endpoint de consulta
// (GET /api/financeiro/:id/timeline) — timelineDoTitulo() acima fica como
// está (assinatura/retorno usados por outros módulos e testes existentes).
export async function timelineDoTituloPaginada(contasFinanceirasId, { limit = 50, offset = 0 } = {}) {
  const { data, error, count } = await supabase
    .from('collection_timeline_events')
    .select('*', { count: 'exact' })
    .eq('contas_financeiras_id', contasFinanceirasId)
    .order('criado_em', { ascending: true })
    .range(offset, offset + limit - 1)
  if (error) throw error
  return { eventos: data ?? [], total: count ?? 0 }
}

// Labels estáveis pra exibição — um por tipo de evento já emitido hoje pelo
// motor de cobrança v2. Tipo desconhecido (futuro tipo novo, ou um dos ~15
// tipos usados só pelo módulo de NF-e, que é OUTRA tabela/função com o
// mesmo nome registrarEvento — nunca aparecem aqui) cai no fallback: mostra
// o próprio código, nunca quebra.
const LABELS_EVENTO = Object.freeze({
  MENSAGEM_ENVIADA: 'Mensagem enviada',
  MENSAGEM_FALHOU: 'Falha no envio',
  MENSAGEM_REENVIADA_TIMEOUT: 'Reenviado por timeout',
  COBRANCA_BLOQUEADA_OPT_OUT: 'Cobrança bloqueada (opt-out)',
  SUGESTAO_IA: 'Sugestão da IA',
  PAGO: 'Pagamento confirmado',
  PROMESSA_PAGAMENTO: 'Promessa de pagamento registrada',
  PROMESSA_CUMPRIDA: 'Promessa cumprida',
  PROMESSA_QUEBRADA: 'Promessa quebrada',
  PROMESSA_SUBSTITUIDA: 'Promessa substituída',
  PROMESSA_CANCELADA: 'Promessa cancelada',
})

// Allowlist (nunca denylist) de campos de `dados` seguros pra sair pela API
// — por tipo de evento. Qualquer campo NÃO listado aqui nunca é exposto
// (ex: dispatch_id/attempt_id/instance_id/suggestion_id/promise_id — UUIDs
// internos sem valor pro operador; se um provider_message_id ou outro campo
// novo vier a conter algo sensível no futuro, o padrão seguro é continuar
// de fora até alguém adicionar explicitamente aqui).
const CAMPOS_METADATA_SEGUROS = Object.freeze({
  MENSAGEM_ENVIADA: ['provider_message_id'],
  MENSAGEM_FALHOU: ['category'],
  COBRANCA_BLOQUEADA_OPT_OUT: ['reason'],
  PAGO: ['dispatches', 'ligacoes', 'promessaCumprida', 'motivo'],
  PROMESSA_PAGAMENTO: ['valor', 'promised_date'],
  SUGESTAO_IA: ['intent', 'recommended_action', 'requires_human', 'reason_codes'],
})

// Serializador de saída seguro — nunca repassa `dados` bruto. Usado pelo
// endpoint de consulta; não afeta o que fica gravado no banco.
export function serializarEventoTimeline(evento) {
  const camposSeguros = CAMPOS_METADATA_SEGUROS[evento.tipo] ?? []
  const metadata = {}
  if (evento.dados && typeof evento.dados === 'object') {
    for (const campo of camposSeguros) {
      if (campo in evento.dados) metadata[campo] = evento.dados[campo]
    }
  }
  return {
    id: evento.id,
    tipo: evento.tipo,
    label: LABELS_EVENTO[evento.tipo] ?? evento.tipo,
    criado_em: evento.criado_em,
    origem: evento.origem,
    resumo: evento.descricao,
    metadata,
  }
}
