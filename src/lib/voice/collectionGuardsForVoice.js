// 2026-08-16 — prontidão SIP trunk externo (Nvoip), item 6 do pedido: antes
// de uma FUTURA ligação de cobrança real, o pipeline vai precisar validar os
// mesmos guards que já protegem o WhatsApp. Este arquivo PREPARA/AUDITA essa
// checagem reaproveitando as funções reais já existentes e testadas — nunca
// duplica a regra (mesmo racional de doNotContactGuard.js/estaEmDoNotContact
// pro caminho WhatsApp).
//
// NÃO é chamado por nenhum job/rota de execução real ainda — a régua de
// cobrança continua 100% desligada da voz nesta rodada (pedido explícito).
// `avaliarGuardsCobrancaParaLigacao()` existe pra já estar pronta e testada
// quando essa decisão futura for tomada, não pra rodar sozinha agora.
import { tituloEstaQuitado } from '../collection/paymentGuard.js'
import { promessaAtivaPara } from '../collection/promises.js'
import { estaEmDoNotContact } from '../collection/doNotContactGuard.js'
import { verificarFrescorSync } from '../collection/financialSyncGuard.js'

// Guards de TÍTULO — quitado, cancelado, em_revisao_financeira (os três
// dentro de tituloEstaQuitado(), mesma fonte de verdade do WhatsApp,
// paymentGuard.js:14-28) + promessa ativa + DNC (canal 'ligacao', que
// collection_do_not_contact já suporta no schema mas nunca era consultado —
// nem pelo WhatsApp nem pela voz, até este arquivo). Telefone ausente
// bloqueia (não dá pra ligar sem número). financialSyncGuard é OPERACIONAL/
// GLOBAL, não por título — ver avaliarGuardGlobalParaLigacao() abaixo,
// mantido separado de propósito (mesmo racional do banner de cobrança:
// "automação ativa" x "envio permitido agora" não podem ser a mesma coisa).
export async function avaliarGuardsTituloParaLigacao(contasFinanceirasId, clienteTelefone) {
  if (!clienteTelefone) {
    return { permitido: false, motivo: 'sem_telefone: título sem telefone de cobrança cadastrado' }
  }

  if (await tituloEstaQuitado(contasFinanceirasId)) {
    return { permitido: false, motivo: 'titulo_quitado_cancelado_ou_em_revisao' }
  }

  const promessa = await promessaAtivaPara(contasFinanceirasId)
  if (promessa) {
    return { permitido: false, motivo: `promessa_ativa: promise_id=${promessa.id}` }
  }

  const dnc = await estaEmDoNotContact(clienteTelefone, ['todos', 'ligacao'])
  if (dnc.blocked) {
    return { permitido: false, motivo: `opt_out: ${dnc.reason}` }
  }

  return { permitido: true, motivo: null }
}

// Guard GLOBAL/operacional — financialSyncGuard não é "deste título", é do
// sistema inteiro (mesma leitura cacheada já usada por collectionRouting.js
// pro WhatsApp). Chamado uma vez por decisão de ligar, não por título.
export async function avaliarGuardGlobalParaLigacao() {
  const guardSync = await verificarFrescorSync()
  if (!guardSync.allowed) {
    return { permitido: false, motivo: `financial_sync_guard: ${guardSync.reason}` }
  }
  return { permitido: true, motivo: null }
}

// Composição — TODOS os guards de cobrança (não confundir com os guards de
// PILOTO/telefonia de externalPilotGuardrails.js, que são checados à parte;
// uma futura orquestração real precisa das DUAS composições passando).
export async function avaliarGuardsCobrancaParaLigacao(contasFinanceirasId, clienteTelefone) {
  const global = await avaliarGuardGlobalParaLigacao()
  if (!global.permitido) return global

  return avaliarGuardsTituloParaLigacao(contasFinanceirasId, clienteTelefone)
}
