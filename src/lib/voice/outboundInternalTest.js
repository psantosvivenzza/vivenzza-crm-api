// Voice AI — VOICE AI OUTBOUND INTERNAL MVP. Lógica PURA (sem chamadas de
// rede/ARI aqui — só decisão/validação), deliberadamente separada do
// trigger script e do ariCallService.js pra ser 100% testável sem jamais
// fazer o telefone tocar.
//
// REGRA DE OURO deste MVP: o único destino que este código jamais permite
// é o ramal interno de teste. Não existe parâmetro de destino em lugar
// nenhum do fluxo — o valor é uma CONSTANTE, e ainda assim validado
// explicitamente antes de qualquer originate, como defesa em profundidade
// (fail-closed: qualquer coisa diferente de PJSIP/7001 lança exceção).
export const ENDPOINT_PERMITIDO = 'PJSIP/7001'
export const APP_ARGS_MARCADOR = 'outbound-internal-test'
export const CONTEXTO_MARCADOR = 'INTERNAL_OUTBOUND_TEST'
export const NO_ANSWER_TIMEOUT_S = 30

export function validarDestinoPermitido(endpoint) {
  if (endpoint !== ENDPOINT_PERMITIDO) {
    throw new Error(`destino não permitido neste MVP: "${endpoint}" — único destino autorizado é "${ENDPOINT_PERMITIDO}" (sem trunk/PSTN/cliente real)`)
  }
  return true
}

// Payload determinístico pro originate — nunca inclui telefone real, id de
// cliente, valor financeiro ou qualquer dado de cobrança. `ARI_APP` vem de
// fora (mesma env já usada pelo serviço inbound) pra nunca divergir do app
// que já está com a conexão WebSocket ativa.
export function construirPayloadOriginate(ariApp) {
  validarDestinoPermitido(ENDPOINT_PERMITIDO)
  return {
    endpoint: ENDPOINT_PERMITIDO,
    app: ariApp,
    appArgs: APP_ARGS_MARCADOR,
    callerId: 'Vivenzza Voice AI <7000>',
    timeout: NO_ANSWER_TIMEOUT_S,
    variables: { VIVENZZA_OUTBOUND_TEST: '1' },
  }
}

// Guard de concorrência: neste MVP de operador único, qualquer canal ARI
// já existente é motivo suficiente pra bloquear uma nova originação (não
// há tráfego legítimo concorrente nesse Asterisk de teste interno).
export function avaliarChamadaJaAtiva(listaCanaisAtual) {
  const canais = Array.isArray(listaCanaisAtual) ? listaCanaisAtual : []
  return canais.length > 0
}

export function avaliarEndpointOnline(endpointInfo) {
  return endpointInfo?.state === 'online'
}

// Classifica a causa de encerramento de um canal que NUNCA chegou a entrar
// em Stasis (ou seja, nunca foi atendido) — usado pra reportar
// NO_ANSWER/BUSY/FAILED de forma auditável (ver PARTE 10 do pedido).
export function classificarCausaSemAtendimento(causeCode) {
  const codigo = Number(causeCode)
  if (codigo === 17) return 'BUSY'
  if (codigo === 18 || codigo === 19) return 'NO_ANSWER'
  if (codigo === 16) return 'CANCELLED'
  return 'FAILED'
}
