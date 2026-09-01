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
import { promessaAtivaPara, marcarPromessaCumprida } from './promises.js'

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
  const status = await statusQuitacaoTitulo(contasFinanceirasId)
  const canceladas = { dispatches: 0, promessaCumprida: false, ligacoes: 0, motivo: status.motivo }
  if (!status.quitado) return canceladas

  const { data: dispatches, error: errDispatches } = await supabase
    .from('collection_dispatches')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .in('status', ['queued', 'sending'])
  if (errDispatches) throw errDispatches

  for (const d of dispatches ?? []) {
    const { data: cancelado, error: errCancelar } = await supabase
      .from('collection_dispatches')
      .update({ status: 'cancelled', cancelado_em: new Date().toISOString(), cancelado_motivo: status.motivo })
      .eq('id', d.id)
      .in('status', ['queued', 'sending']) // condicional — se outra execução já cancelou, 0 linhas afetadas
      .select()
      .maybeSingle()
    if (errCancelar) throw errCancelar
    if (cancelado) canceladas.dispatches++
  }

  // collection_calls (fila de ligação agendada) é uma tabela da frente de
  // voz experimental (docs/archive/cobranca-ai-v2-original/) — não existe no
  // schema real hoje (a tabela real de voz, voice_calls, é só auditoria
  // técnica de chamada já feita, não uma fila de pendências a cancelar).
  // Erro 42P01 (relation does not exist, SQLSTATE do Postgres — não é uma
  // string arbitrária, é o código padrão pra "tabela não existe") é tratado
  // como "feature ainda não existe" e SÓ esse código — qualquer outro erro
  // (conexão caída, auth, timeout) continua propagando normalmente, nunca é
  // engolido. Se a tabela vier a existir no futuro, o cancelamento passa a
  // funcionar sem mudar código.
  const { data: ligacoes, error: errLigacoes } = await supabase
    .from('collection_calls')
    .select('id')
    .eq('contas_financeiras_id', contasFinanceirasId)
    .in('status', ['agendada', 'em_andamento'])
  if (errLigacoes && errLigacoes.code !== '42P01') throw errLigacoes
  for (const l of ligacoes ?? []) {
    const { data: cancelada, error: errCancelarLigacao } = await supabase
      .from('collection_calls')
      .update({ status: 'cancelada' })
      .eq('id', l.id)
      .in('status', ['agendada', 'em_andamento'])
      .select()
      .maybeSingle()
    if (errCancelarLigacao && errCancelarLigacao.code !== '42P01') throw errCancelarLigacao
    if (cancelada) canceladas.ligacoes++
  }

  if (status.motivo === 'quitado') {
    const promessa = await promessaAtivaPara(contasFinanceirasId)
    if (promessa) {
      const marcada = await marcarPromessaCumprida(promessa.id, { origem: ORIGEM.PAYMENT_RECONCILIATION })
      canceladas.promessaCumprida = Boolean(marcada)
    }
    // Guarda extra contra o caso raro de duas execuções concorrentes
    // cancelarem DISPATCHES DIFERENTES do mesmo título (cada uma vê
    // canceladas.dispatches>0 de forma legítima, nenhuma delas duplicou uma
    // transição já feita pela outra) — sem isso, as duas emitiriam PAGO. Um
    // título só é pago 1x na vida neste domínio, então "já existe algum
    // evento PAGO" é uma checagem suficiente (não uma janela de corrida
    // perfeitamente atômica, mas node-cron noOverlap:true nos 2 jobs novos já
    // elimina a fonte real de concorrência — isto é defesa em profundidade).
    if (canceladas.dispatches || canceladas.promessaCumprida || canceladas.ligacoes) {
      const { data: pagoExistente, error: errCheck } = await supabase
        .from('collection_timeline_events')
        .select('id')
        .eq('contas_financeiras_id', contasFinanceirasId)
        .eq('tipo', 'PAGO')
        .limit(1)
        .maybeSingle()
      if (errCheck) throw errCheck
      if (!pagoExistente) {
        await registrarEvento({
          contasFinanceirasId,
          tipo: 'PAGO',
          origem: ORIGEM.PAYMENT_RECONCILIATION,
          descricao: `Automação cancelada por pagamento confirmado (${canceladas.dispatches} disparo(s), ${canceladas.ligacoes} ligação(ões), promessa cumprida=${canceladas.promessaCumprida})`,
          dados: canceladas,
        })
      }
    }
  }

  return canceladas
}

// Job periódico (src/jobs/payment-reconciliation-sweep.js) — varre títulos com
// dispatch/ligação/promessa pendente e re-checa a situação atual, pra pegar o
// caso em que o pagamento/cancelamento/revisão financeira aconteceu DEPOIS do
// agendamento (corrida pagamento x job). Idempotente: uma segunda execução não
// encontra mais nada pendente pra esses títulos (dispatch já 'cancelled',
// promessa já 'cumprida' — nenhum dos dois é recontado pelas queries acima).
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
    const resultado = await cancelarAutomacaoPorPagamento(id)
    if (resultado.dispatches || resultado.ligacoes || resultado.promessaCumprida) quitados++
  }
  return { verificados: idsComPendencia.size, quitados }
}
