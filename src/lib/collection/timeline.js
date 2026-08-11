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
