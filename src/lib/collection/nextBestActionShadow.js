// FASE B.4/B.5 (homologação, 2026-08-11) — NBA SHADOW CANAL-AGNÓSTICO.
//
// Problema real encontrado na FASE B.3: o SHADOW usava a MESMA árvore de
// decisão da execução real, então HUMAN_CALL/AI_CALL/AI_WHATSAPP nunca
// apareciam no shadow simplesmente porque as flags de EXECUÇÃO
// (human_call_alerts/ai_voice_calls/ai_whatsapp) estavam desligadas — o
// shadow ficava artificialmente limitado a WHATSAPP/NO_ACTION, quando a
// pergunta que ele deveria responder é "qual seria a melhor ação se todos os
// canais estivessem disponíveis", não "qual ação a execução real tomaria
// hoje".
//
// Este módulo SEPARA (B.4) e depois (B.5) refina em 3 eixos independentes:
//   recommended_channel/recommended_handler — O QUÊ e QUEM, calculados com
//                            todos os canais conceitualmente disponíveis
//                            (config-override só dentro desta função, nunca
//                            persistido/aplicado em automacoes_config real)
//   recommended_action     — mantido por compatibilidade, sempre DERIVADO
//                            dos dois campos acima via derivarAcao()
//   execution_available    — se ESSA ação específica pode executar HOJE,
//                            segundo as flags reais (as mesmas que
//                            decidirProximaAcao() sempre respeitou)
//   execution_block_reason — motivo, quando execution_available=false
//   channel_cost_class     — classificação RELATIVA (não monetária) de custo
//                            operacional do canal recomendado — informativo,
//                            não usado ainda para MUDAR nenhuma decisão
//
// As flags de execução continuam controlando 100% da execução real — nada
// aqui despacha, envia WhatsApp, liga pra IA/humano ou muda
// automacoes_config. Reusa carregarContextoNba()/escolherCanalNba() de
// nextBestAction.js pra nunca divergir de decidirProximaAcao() sobre QUEM é
// elegível pra cobrança (quitado/cancelado/opt-out/promessa/fora da régua/
// sem telefone são idênticos nos dois modos) — só diverge em QUAL CANAL
// recomendar quando a conta É elegível.
import { obterConfigCobranca } from './featureFlags.js'
import { ACAO, CANAL, EXECUTOR, carregarContextoNba, escolherCanalNba } from './nextBestAction.js'
import { STATUS_CLIENTE_ERP, statusClienteErpPara } from './clienteErpStatus.js'

// Override usado SÓ para calcular a recomendação — nunca lido/escrito em
// automacoes_config. As 3 flags que a árvore de decisão consulta condicionalmente.
const CANAIS_TODOS_DISPONIVEIS = Object.freeze({
  ai_voice_calls: true,
  human_call_alerts: true,
  ai_whatsapp: true,
})

const MOTIVO_BLOQUEIO = Object.freeze({
  [ACAO.HUMAN_CALL]: 'HUMAN_CALL_DISABLED',
  [ACAO.AI_CALL]: 'AI_VOICE_DISABLED',
  [ACAO.AI_WHATSAPP]: 'AI_WHATSAPP_DISABLED',
  [ACAO.WHATSAPP]: 'WHATSAPP_REGUA_DISABLED',
})

// NO_ACTION/WAIT_PROMISE/PAYMENT_CHECK/HUMAN_REVIEW não dependem de nenhum
// canal externo (não enviam mensagem, não ligam, não chamam IA) — sempre
// "executáveis" no sentido de que a ação em si (ou a ausência dela) já é o
// comportamento real hoje, não depende de nenhuma feature flag de canal.
function avaliarExecucao(acao, configReal) {
  const flagPorAcao = {
    [ACAO.HUMAN_CALL]: configReal.human_call_alerts === true,
    [ACAO.AI_CALL]: configReal.ai_voice_calls === true,
    [ACAO.AI_WHATSAPP]: configReal.ai_whatsapp === true,
    [ACAO.WHATSAPP]: configReal.cobranca_whatsapp_ativa === true,
  }
  if (!(acao in flagPorAcao)) return { execution_available: true, execution_block_reason: null }
  const disponivel = flagPorAcao[acao]
  return { execution_available: disponivel, execution_block_reason: disponivel ? null : MOTIVO_BLOQUEIO[acao] }
}

// PASSO 11 (homologação B.5) — classificação RELATIVA de custo operacional
// por AÇÃO final (não por canal isolado — AI_WHATSAPP e WHATSAPP são o mesmo
// canal mas custo bem diferente: um é 100% automático, outro consome
// mensagens de IA). Não são valores monetários (pedido explícito) — só uma
// ordem de grandeza pra uso futuro do NBA (ex: desempatar entre duas ações
// igualmente válidas). Não influencia nenhuma decisão nesta fase.
export const CHANNEL_COST_CLASS = Object.freeze({
  [ACAO.NO_ACTION]: 'NONE',
  [ACAO.WAIT_PROMISE]: 'NONE',
  [ACAO.WHATSAPP]: 'LOW',
  [ACAO.AI_WHATSAPP]: 'LOW',
  [ACAO.PAYMENT_CHECK]: 'LOW',
  [ACAO.AI_CALL]: 'MEDIUM',
  [ACAO.HUMAN_CALL]: 'HIGH',
  [ACAO.HUMAN_REVIEW]: 'HIGH',
})

// PASSO 7 (homologação B.5) — gate de status do cliente ERP, só no SHADOW
// (decidirProximaAcao/execução real NÃO chama isto nesta fase — pedido
// explícito "integrar LOCALMENTE... na avaliação NBA Shadow"). Só se aplica
// quando o contexto NÃO já está "encerrado" (título pago/cancelado/opt-out/
// promessa ativa/fora da régua/sem telefone continuam tendo prioridade — a
// realidade financeira do título já resolve a questão nesses casos, não
// precisa do status do cliente pra decidir não automatizar).
function aplicarGateClienteErp(status, contextoDecisao) {
  if (status.status === STATUS_CLIENTE_ERP.ATIVO) return null

  const motivo = status.status === STATUS_CLIENTE_ERP.INATIVO ? 'CLIENTE_INATIVO' : 'CLIENTE_DESCONHECIDO'
  return {
    channel: CANAL.REVIEW,
    handler: EXECUTOR.HUMAN,
    acao: ACAO.HUMAN_REVIEW,
    reason_codes: [...contextoDecisao.reasonCodes, motivo],
  }
}

// `recovery`/`priority` (FASE B.5) — mesmo mecanismo de carregarContextoNba():
// permite simulação de carteira inteira sem persistir nenhum score novo.
export async function avaliarNbaShadow(contasFinanceirasId, { recovery, priority } = {}) {
  const contexto = await carregarContextoNba(contasFinanceirasId, { recovery, priority })

  if (contexto.encerrado) {
    return {
      recommended_channel: contexto.encerrado.channel,
      recommended_handler: contexto.encerrado.handler,
      recommended_action: contexto.encerrado.acao,
      reason_codes: contexto.encerrado.reason_codes,
      etapa: null,
      diasAtraso: null,
      execution_available: true,
      execution_block_reason: null,
      channel_cost_class: CHANNEL_COST_CLASS[contexto.encerrado.acao],
      cliente_erp_status: null, // não avaliado — título já resolvido antes desse gate
    }
  }

  const [statusCliente, configReal] = await Promise.all([
    statusClienteErpPara(contasFinanceirasId),
    obterConfigCobranca(),
  ])
  const gateCliente = aplicarGateClienteErp(statusCliente, contexto)

  const decisao = gateCliente
    ?? escolherCanalNba({ config: { ...configReal, ...CANAIS_TODOS_DISPONIVEIS }, ...contexto })

  const execucao = avaliarExecucao(decisao.acao, configReal)

  return {
    recommended_channel: decisao.channel,
    recommended_handler: decisao.handler,
    recommended_action: decisao.acao,
    reason_codes: decisao.reason_codes,
    etapa: contexto.etapa,
    diasAtraso: contexto.diasAtraso,
    channel_cost_class: CHANNEL_COST_CLASS[decisao.acao],
    cliente_erp_status: statusCliente.status,
    ...execucao,
  }
}
