// Promessas de pagamento estruturadas (FASE 3). Enquanto uma promessa está ativa:
// SILÊNCIO INTELIGENTE — o motor de dispatch (dispatchEngine.js) e o NBA
// (nextBestAction.js) consultam promessaAtivaPara() antes de agir e pulam o título.
import { supabase } from '../supabase-admin.server.js'
import { registrarEvento, ORIGEM } from './timeline.js'

export async function promessaAtivaPara(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('collection_promises')
    .select('*')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .eq('status', 'ativa')
    .maybeSingle()
  if (error) throw error
  return data
}

// Registrar uma nova promessa cancela automaticamente qualquer promessa ativa
// anterior para o mesmo título (nunca duas promessas ativas coexistindo — reforçado
// também pelo índice único parcial no banco). `origem` é AUTOMATION/AI/HUMAN,
// nunca inventado pela IA sem confirmação explícita de data+valor (ver AI_AGENT.md).
export async function registrarPromessa({ contasFinanceirasId, clienteNome, clienteTelefone, valor, promisedDate, origem, notes = null }) {
  if (!['AUTOMATION', 'AI', 'HUMAN'].includes(origem)) {
    throw new Error(`Origem de promessa inválida: ${origem}`)
  }
  if (!(Number(valor) > 0)) {
    throw new Error('Valor da promessa precisa ser positivo')
  }

  const anterior = await promessaAtivaPara(contasFinanceirasId)
  if (anterior) {
    await supabase
      .from('collection_promises')
      .update({ status: 'cancelada', cancelled_at: new Date().toISOString() })
      .eq('id', anterior.id)
    await registrarEvento({
      contasFinanceirasId,
      clienteTelefone,
      tipo: 'PROMESSA_SUBSTITUIDA',
      origem,
      descricao: `Promessa anterior de ${anterior.promised_date} substituída por nova negociação`,
    })
  }

  const { data, error } = await supabase
    .from('collection_promises')
    .insert({
      contas_financeiras_id: contasFinanceirasId,
      cliente_nome: clienteNome,
      cliente_telefone: clienteTelefone,
      valor,
      promised_date: promisedDate,
      origem,
      notes,
    })
    .select()
    .single()
  if (error) throw error

  await registrarEvento({
    contasFinanceirasId,
    clienteTelefone,
    tipo: 'PROMESSA_PAGAMENTO',
    origem,
    descricao: `Promessa registrada: R$ ${Number(valor).toFixed(2)} até ${promisedDate}`,
    dados: { promise_id: data.id, valor, promised_date: promisedDate },
  })

  return data
}

export async function marcarPromessaCumprida(promiseId, { origem = ORIGEM.SYSTEM } = {}) {
  const { data, error } = await supabase
    .from('collection_promises')
    .update({ status: 'cumprida', fulfilled_at: new Date().toISOString() })
    .eq('id', promiseId)
    .select()
    .single()
  if (error) throw error

  await registrarEvento({
    contasFinanceirasId: data.contas_financeiras_id,
    clienteTelefone: data.cliente_telefone,
    tipo: 'PROMESSA_CUMPRIDA',
    origem,
    descricao: 'Promessa de pagamento cumprida',
    dados: { promise_id: promiseId },
  })
  return data
}

export async function marcarPromessaQuebrada(promiseId) {
  const { data, error } = await supabase
    .from('collection_promises')
    .update({ status: 'quebrada', broken_at: new Date().toISOString() })
    .eq('id', promiseId)
    .select()
    .single()
  if (error) throw error

  await registrarEvento({
    contasFinanceirasId: data.contas_financeiras_id,
    clienteTelefone: data.cliente_telefone,
    tipo: 'PROMESSA_QUEBRADA',
    origem: ORIGEM.SYSTEM,
    descricao: 'Promessa de pagamento vencida sem confirmação de pagamento',
    dados: { promise_id: promiseId },
  })
  return data
}

// Job: promessas vencidas (promised_date < hoje BRT) e ainda 'ativa' viram 'quebrada'.
// Chamado por src/jobs/collection-promise-followup.js. Recalcular prioridade fica a
// cargo do próximo cálculo de priorityScore (que já soma pontos por promessa quebrada
// consultando esta tabela) — não há necessidade de mexer em outra tabela aqui.
export async function processarPromessasVencidas(hojeBrtISO) {
  const { data: vencidas, error } = await supabase
    .from('collection_promises')
    .select('id')
    .eq('status', 'ativa')
    .lt('promised_date', hojeBrtISO)
  if (error) throw error

  const resultados = []
  for (const p of vencidas ?? []) {
    resultados.push(await marcarPromessaQuebrada(p.id))
  }
  return resultados
}
