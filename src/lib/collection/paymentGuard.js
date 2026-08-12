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
import { registrarEvento, ORIGEM } from './timeline.js'
import { promessaAtivaPara } from './promises.js'

export async function tituloEstaQuitado(contasFinanceirasId) {
  const { data, error } = await supabase
    .from('contas_financeiras')
    .select('id, valor, valor_pago, status, em_revisao_financeira')
    .eq('id', contasFinanceirasId)
    .maybeSingle()
  if (error) throw error
  if (!data) return true // título não existe mais (deletado/duplicata reconciliada) — não cobrar

  if (data.status === 'cancelada') return true
  if (data.em_revisao_financeira) return true // estorno em disputa — pausa automação, não é "quitado" mas não deve prosseguir

  const saldo = Number(data.valor || 0) - Number(data.valor_pago || 0)
  return saldo <= 0
}

// Cancela dispatches em aberto (queued/sending) e a promessa ativa de um título que
// acabou de ser identificado como quitado — idempotente (repetir não tem efeito
// colateral em dispatch já cancelado/entregue).
export async function cancelarAutomacaoPorPagamento(contasFinanceirasId) {
  const canceladas = { dispatches: 0, promessa: false, ligacoes: 0 }

  const { data: dispatches, error: errDispatches } = await supabase
    .from('collection_dispatches')
    .select('id, status')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .in('status', ['queued', 'sending'])
  if (errDispatches) throw errDispatches

  for (const d of dispatches ?? []) {
    await supabase
      .from('collection_dispatches')
      .update({ status: 'cancelled', cancelado_em: new Date().toISOString(), cancelado_motivo: 'pagamento_confirmado' })
      .eq('id', d.id)
    canceladas.dispatches++
  }

  const promessa = await promessaAtivaPara(contasFinanceirasId)
  if (promessa) {
    await supabase.from('collection_promises').update({ status: 'cumprida', fulfilled_at: new Date().toISOString() }).eq('id', promessa.id)
    canceladas.promessa = true
  }

  const { data: ligacoes, error: errLigacoes } = await supabase
    .from('collection_calls')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .in('status', ['agendada', 'em_andamento'])
  if (errLigacoes) throw errLigacoes
  for (const l of ligacoes ?? []) {
    await supabase.from('collection_calls').update({ status: 'cancelada' }).eq('id', l.id)
    canceladas.ligacoes++
  }

  if (canceladas.dispatches || canceladas.promessa || canceladas.ligacoes) {
    await registrarEvento({
      contasFinanceirasId,
      tipo: 'PAGO',
      origem: ORIGEM.PAYMENT_RECONCILIATION,
      descricao: `Automação cancelada por pagamento confirmado (${canceladas.dispatches} disparo(s), ${canceladas.ligacoes} ligação(ões), promessa=${canceladas.promessa})`,
      dados: canceladas,
    })
  }

  return canceladas
}

// Job periódico (chamado por src/jobs/collection-payment-guard.js) — varre títulos
// com dispatch/ligação/promessa pendente e re-checa quitação, pra pegar o caso em
// que o pagamento foi dado baixa DEPOIS do agendamento (corrida pagamento x job).
export async function varrerTitulosPendentesEcancelarQuitados() {
  const idsComPendencia = new Set()

  const { data: dispatchesAbertos } = await supabase
    .from('collection_dispatches')
    .select('contas_financeiras_id')
    .in('status', ['queued', 'sending'])
  for (const d of dispatchesAbertos ?? []) idsComPendencia.add(d.contas_financeiras_id)

  const { data: promessasAtivas } = await supabase
    .from('collection_promises')
    .select('contas_financeiras_id')
    .eq('status', 'ativa')
  for (const p of promessasAtivas ?? []) idsComPendencia.add(p.contas_financeiras_id)

  const { data: ligacoesAbertas } = await supabase
    .from('collection_calls')
    .select('contas_financeiras_id')
    .in('status', ['agendada', 'em_andamento'])
  for (const l of ligacoesAbertas ?? []) idsComPendencia.add(l.contas_financeiras_id)

  let quitados = 0
  for (const id of idsComPendencia) {
    if (await tituloEstaQuitado(id)) {
      await cancelarAutomacaoPorPagamento(id)
      quitados++
    }
  }
  return { verificados: idsComPendencia.size, quitados }
}
