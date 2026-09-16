// 2026-08-16 — prontidão SIP trunk externo (Nvoip). Lógica PURA (sem
// rede/ARI/DB aqui), espelhando outboundInternalTest.js — mas pra
// "vivenzza-external-test", o primeiro teste de discagem PÚBLICA (fora do
// ramal interno PJSIP/7001).
//
// REGRA DE OURO: só chega a montar um payload de originate depois de
// avaliarAutorizacaoChamadaExterna() (externalPilotGuardrails.js) E os
// limites globais (avaliarLimiteGlobalPorHora/Dia) terem autorizado — e
// mesmo assim, resolverDestino(EXTERNAL) (destinoResolver.js) ainda lança
// sempre hoje (TRUNK_EXTERNO_CONFIGURADO=false, não tocado por este
// arquivo) — dupla trava, igual ao MVP interno já fazia com o endpoint fixo.
import { TIPO_DESTINO, resolverDestino } from './destinoResolver.js'
import { lerConfigNvoip } from './externalConfig.js'

export const CONTEXTO_MARCADOR = 'EXTERNAL_PILOT_TEST'
export const NO_ANSWER_TIMEOUT_S = 30

// Nunca inclui dado de cobrança (título/cliente/valor) — este é um teste de
// PIPELINE/trunk, não uma ligação de cobrança real (essa é uma decisão
// futura separada, ver collectionGuardsForVoice.js).
export function construirPayloadOriginateExterno({ numero, ariApp, callerId }) {
  if (!numero) throw new Error('construirPayloadOriginateExterno: número é obrigatório')
  // resolverDestino lança aqui hoje, sempre — TRUNK_EXTERNO_CONFIGURADO=false.
  // Esta função nunca contorna isso; só existe pra já estar pronta/testável
  // quando (e somente quando) um trunk real for provisionado.
  const endpointBase = resolverDestino(TIPO_DESTINO.EXTERNAL)
  // ACHADO REAL (2026-09-16, primeira tentativa de chamada real) —
  // `PJSIP/<endpoint>/<numero-cru>` NÃO é um dial-string válido pra um
  // trunk com destino explícito: o Asterisk tenta interpretar o terceiro
  // segmento como uma URI SIP completa e rejeita ("Could not create
  // dialog to invalid URI '+55...'"). Erro real visto em
  // /var/log/asterisk/messages.log:
  //   res_pjsip.c: Endpoint 'nvoip-endpoint': Could not create dialog to
  //   invalid URI '+5551991567661'. Is endpoint registered and reachable?
  // Fix: montar a URI SIP completa (sip:<numero>@<host-da-nvoip>), lida de
  // NVOIP_SIP_SERVER/NVOIP_SIP_PORT (externalConfig.js) — nunca
  // hardcoded aqui, pra nunca dessincronizar do que está em pjsip_nvoip.conf.
  const { sipServer, sipPort } = lerConfigNvoip()
  if (!sipServer) throw new Error('construirPayloadOriginateExterno: NVOIP_SIP_SERVER não configurado — não sei montar a URI de destino')
  const uriDestino = `sip:${numero}@${sipServer}:${sipPort || 5060}`
  return {
    endpoint: `${endpointBase}/${uriDestino}`,
    app: ariApp,
    appArgs: CONTEXTO_MARCADOR,
    callerId: callerId || 'Vivenzza Voice AI',
    timeout: NO_ANSWER_TIMEOUT_S,
    variables: { VIVENZZA_EXTERNAL_TEST: '1' },
  }
}

export function avaliarChamadaJaAtiva(listaCanaisAtual) {
  const canais = Array.isArray(listaCanaisAtual) ? listaCanaisAtual : []
  return canais.length > 0
}

export function avaliarEndpointOnline(endpointInfo) {
  return endpointInfo?.state === 'online'
}

// Mesma classificação já usada pelo MVP interno (outboundInternalTest.js) —
// não duplica a regra, só reexporta pra quem só importar deste arquivo não
// precisar saber que a implementação é compartilhada.
export { classificarCausaSemAtendimento } from './outboundInternalTest.js'
