// "Antes de QUALQUER ação: consultar situação atual do título. Se pago: cancelar
// mensagem agendada, retry, chamada, alerta, promessa pendente." — este módulo é o
// único lugar que decide "este título ainda pode ser cobrado agora?", consultado
// pelo dispatchEngine antes de cada tentativa de envio e por um job periódico que
// varre dispatches/ligações/promessas pendentes e cancela o que ficou órfão porque
// o pagamento entrou depois do agendamento (corrida pagamento x job).
//
// Usa exatamente a mesma lógica de saldo já usada em cobranca-whatsapp.js
// (valor - valor_pago <= 0 => quitado) — não reinventa outra fonte de verdade.
import { supabase } from '../supabase-admin.server.js'

// Usar apenas nos acessos diretos a collection_calls, tabela opcional.
// PostgreSQL direto retorna 42P01; PostgREST retorna PGRST205 para tabela ausente.
// Permissão, rede, coluna ausente e outros códigos continuam sendo erros.
function tabelaLigacoesOpcionalAusente(error) {
  return error?.code === '42P01' || error?.code === 'PGRST205'
}

// Motivos possíveis, do mais específico pro genérico — usados por
// dispatchEngine.enviarComFailover para distinguir a causa do bloqueio (antes
// os 4 casos abaixo colapsavam no mesmo motivo:'quitado'). `quitado:true`
// preserva o significado original da função ("não prosseguir com cobrança").
export async function statusQuitacaoTitulo(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('contas_financeiras')
    .select('id, valor, valor_pago, status, em_revisao_financeira')
    .eq('id', contasFinanceirasId)
    .maybeSingle()
  if (error) throw error
  if (!data) return { quitado: true, motivo: 'titulo_inexistente' } // título não existe mais (deletado/duplicata reconciliada) — não cobrar

  if (data.status === 'cancelada') return { quitado: true, motivo: 'cancelado' }
  if (data.em_revisao_financeira) return { quitado: true, motivo: 'em_revisao_financeira' } // estorno em disputa — pausa automação, não é "quitado" mas não deve prosseguir

  const saldo = Number(data.valor || 0) - Number(data.valor_pago || 0)
  return saldo <= 0 ? { quitado: true, motivo: 'quitado' } : { quitado: false, motivo: null }
}

export async function tituloEstaQuitado(contasFinanceirasId) {
  const { quitado } = await statusQuitacaoTitulo(contasFinanceirasId)
  return quitado
}

// Cancela dispatches em aberto (queued/sending) e ligações agendadas/em
// andamento de um título que não pode mais ser cobrado. Idempotente sob
// concorrência real (não só "segunda chamada sequencial não acha mais
// nada"): cada UPDATE é condicional (WHERE status IN (...) de novo, não só
// no SELECT) — se duas execuções concorrentes selecionarem o mesmo dispatch,
// só uma efetivamente muda a linha, a outra afeta 0 linhas e não conta.
// A promessa ativa só é marcada CUMPRIDA e o evento PAGO só é registrado
// quando o motivo é 'quitado' (pagamento real) — cancelado/em_revisao/
// titulo_inexistente só param a automação pendente, nunca fingem que houve
// pagamento (pedido explícito: separar claramente os motivos).
export async function cancelarAutomacaoPorPagamento(contasFinanceirasId) {
  const { data, error } = await supabase.rpc('collection_cancel_paid_atomic', { p_title_id: contasFinanceirasId })
  if (error) throw error
  return data
}

// Job periódico (src/jobs/payment-reconciliation-sweep.js) — varre títulos com
// dispatch/ligação/promessa pendente e re-checa a situação atual, pra pegar o
// caso em que o pagamento/cancelamento/revisão financeira aconteceu DEPOIS do
// agendamento (corrida pagamento x job). Idempotente: uma segunda execução não
// encontra mais nada pendente pra esses títulos (dispatch já 'cancelled',
// promessa já 'cumprida' — nenhum dos dois é recontado pelas queries acima).
export async function varrerTitulosPendentesEcancelarQuitados() {
  const idsComPendencia = new Set()

  const { data: dispatchesAbertos, error: erroDispatches } = await supabase
    .from('collection_dispatches')
    .select('contas_financeiras_id')
    .in('status', ['queued', 'sending'])
  if (erroDispatches) throw erroDispatches
  for (const d of dispatchesAbertos ?? []) idsComPendencia.add(d.contas_financeiras_id)

  const { data: promessasAtivas, error: erroPromessas } = await supabase
    .from('collection_promises')
    .select('contas_financeiras_id')
    .eq('status', 'ativa')
  if (erroPromessas) throw erroPromessas
  for (const p of promessasAtivas ?? []) idsComPendencia.add(p.contas_financeiras_id)

  const { data: ligacoesAbertas, error: erroLigacoes } = await supabase
    .from('collection_calls')
    .select('contas_financeiras_id')
    .in('status', ['agendada', 'em_andamento'])
  // Mesmo contrato restrito à tabela opcional usado no cancelamento individual.
  if (erroLigacoes && !tabelaLigacoesOpcionalAusente(erroLigacoes)) throw erroLigacoes
  for (const l of ligacoesAbertas ?? []) idsComPendencia.add(l.contas_financeiras_id)

  let quitados = 0
  const falhas = []
  for (const id of idsComPendencia) {
    try {
      const resultado = await cancelarAutomacaoPorPagamento(id)
      if (resultado.dispatches || resultado.ligacoes || resultado.promessaCumprida) quitados++
    } catch (error) {
      // Um título problemático não pode impedir a reconciliação dos seguintes.
      // Preserva as causas para o chamador, sem dados de títulos na mensagem do cron.
      falhas.push(error)
    }
  }
  if (falhas.length) {
    const error = new AggregateError(falhas, `Reconciliação incompleta: ${falhas.length} falha(s) em ${idsComPendencia.size} título(s).`)
    error.code = 'PAYMENT_RECONCILIATION_PARTIAL_FAILURE'
    error.resultado = { verificados: idsComPendencia.size, quitados, falhas: falhas.length }
    throw error
  }
  return { verificados: idsComPendencia.size, quitados }
}
