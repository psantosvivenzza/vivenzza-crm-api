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

// Código de erro Postgres pra unique_violation — usado pra reconhecer quando
// o índice único parcial (idx_collection_promises_unica_ativa) bloqueou um
// INSERT concorrente, e distinguir isso de qualquer outro erro real de banco.
export const ERRO_PROMESSA_ATIVA_CONCORRENTE = 'PROMESSA_ATIVA_CONCORRENTE'

// Registrar uma nova promessa cancela automaticamente qualquer promessa ativa
// anterior para o mesmo título (nunca duas promessas ativas coexistindo — reforçado
// também pelo índice único parcial no banco). `origem` é AUTOMATION/AI/HUMAN,
// nunca inventado pela IA sem confirmação explícita de data+valor (ver AI_AGENT.md).
//
// Concorrência (hardening 2026-09-02, revisão da PR #65): o cancelamento da
// promessa anterior é condicional (WHERE id=X AND status='ativa') — igual à
// disciplina de marcarPromessaCumprida/marcarPromessaQuebrada/
// cancelarPromessaAtiva — então PROMESSA_SUBSTITUIDA só é emitido quando a
// transição realmente aconteceu (não quando outra chamada concorrente já
// tinha cancelado/resolvido a mesma promessa primeiro). Se o INSERT final
// esbarrar no índice único (outra chamada concorrente inseriu a ativa
// primeiro), lança um erro reconhecível (code=ERRO_PROMESSA_ATIVA_CONCORRENTE)
// em vez de deixar o erro bruto do Postgres vazar — quem chama decide o
// HTTP/mensagem certos (ver POST /:id/promessa em financeiro.js).
export async function registrarPromessa({ contasFinanceirasId, clienteNome, clienteTelefone, valor, promisedDate, origem, notes = null }) {
  if (!['AUTOMATION', 'AI', 'HUMAN'].includes(origem)) {
    throw new Error(`Origem de promessa inválida: ${origem}`)
  }
  if (!(Number(valor) > 0)) {
    throw new Error('Valor da promessa precisa ser positivo')
  }

  const anterior = await promessaAtivaPara(contasFinanceirasId)
  if (anterior) {
    const { data: canceladaAnterior, error: erroCancelar } = await supabase
      .from('collection_promises')
      .update({ status: 'cancelada', cancelled_at: new Date().toISOString() })
      .eq('id', anterior.id)
      .eq('status', 'ativa')
      .select()
      .maybeSingle()
    if (erroCancelar) throw erroCancelar
    if (canceladaAnterior) {
      await registrarEvento({
        contasFinanceirasId,
        clienteTelefone,
        tipo: 'PROMESSA_SUBSTITUIDA',
        origem,
        descricao: `Promessa anterior de ${anterior.promised_date} substituída por nova negociação`,
      })
    }
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
  if (error) {
    if (error.code === '23505') {
      const conflito = new Error('Já existe uma promessa ativa para este título (criada por outra requisição concorrente)')
      conflito.code = ERRO_PROMESSA_ATIVA_CONCORRENTE
      throw conflito
    }
    throw error
  }

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

// Cancelamento EXPLÍCITO, sem criar promessa nova (diferente da substituição
// embutida em registrarPromessa(), que sempre vem acompanhada de uma
// promessa nova). Transição condicional (WHERE status='ativa') — mesma
// disciplina de concorrência das demais transições deste arquivo. Retorna
// null se não havia promessa ativa (nada a cancelar) ou se outra chamada já
// cancelou/resolveu primeiro.
export async function cancelarPromessaAtiva(contasFinanceirasId, { origem = ORIGEM.HUMAN, motivo = null } = {}) {
  const promessa = await promessaAtivaPara(contasFinanceirasId)
  if (!promessa) return null

  const { data, error } = await supabase
    .from('collection_promises')
    .update({ status: 'cancelada', cancelled_at: new Date().toISOString() })
    .eq('id', promessa.id)
    .eq('status', 'ativa')
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) return null

  await registrarEvento({
    contasFinanceirasId,
    clienteTelefone: data.cliente_telefone,
    tipo: 'PROMESSA_CANCELADA',
    origem,
    descricao: motivo ? `Promessa cancelada: ${motivo}` : 'Promessa cancelada pelo operador',
    dados: { promise_id: data.id },
  })
  return data
}

// Transição condicional (WHERE status='ativa') — se duas chamadas concorrentes
// tentarem marcar a MESMA promessa cumprida (ex: sweep de pagamento rodando 2x
// por overlap de scheduler), só a que efetivamente mudar a linha (a outra já
// vai encontrar status != 'ativa', 0 linhas afetadas) registra o evento.
// Retorna null quando a transição não ocorreu (idempotência real, não só
// "segunda chamada sequencial não encontra mais nada pendente").
export async function marcarPromessaCumprida(promiseId, { origem = ORIGEM.SYSTEM } = {}) {
  const { data, error } = await supabase
    .from('collection_promises')
    .update({ status: 'cumprida', fulfilled_at: new Date().toISOString() })
    .eq('id', promiseId)
    .eq('status', 'ativa')
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) return null

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

// Mesma transição condicional (WHERE status='ativa') que marcarPromessaCumprida
// — protege contra processarPromessasVencidas() rodando 2x concorrentemente.
export async function marcarPromessaQuebrada(promiseId) {
  const { data, error } = await supabase
    .from('collection_promises')
    .update({ status: 'quebrada', broken_at: new Date().toISOString() })
    .eq('id', promiseId)
    .eq('status', 'ativa')
    .select()
    .maybeSingle()
  if (error) throw error
  if (!data) return null

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
// Chamado por src/jobs/promise-expiry-sweep.js (1x/dia, timezone
// America/Sao_Paulo explícito, noOverlap:true). Recalcular prioridade fica a
// cargo do próximo cálculo de priorityScore (que já soma pontos por promessa
// quebrada consultando esta tabela) — não há necessidade de mexer em outra
// tabela aqui. marcarPromessaQuebrada() já é condicional no banco
// (WHERE status='ativa'), então mesmo que duas execuções concorrentes
// selecionem a mesma promessa aqui, só uma efetivamente marca — a outra
// retorna null e é descartada abaixo (nunca emite PROMESSA_QUEBRADA 2x).
export async function processarPromessasVencidas(hojeBrtISO) {
  const { data: vencidas, error } = await supabase
    .from('collection_promises')
    .select('id')
    .eq('status', 'ativa')
    .lt('promised_date', hojeBrtISO)
  if (error) throw error

  const resultados = []
  for (const p of vencidas ?? []) {
    const marcada = await marcarPromessaQuebrada(p.id)
    if (marcada) resultados.push(marcada)
  }
  return resultados
}
