// Voice AI EXTERNAL PILOT READINESS — abstração de destino. Objetivo:
// separar "pra onde a chamada vai" do resto do código, então quando um
// trunk real existir no futuro, ESTE é o único arquivo que precisa mudar
// (nenhum outro módulo deveria conhecer detalhe de endpoint).
//
// Hoje: INTERNAL resolve pro mesmo ramal PJSIP/7001 já homologado (PR #19).
//
// ADAPTER NVOIP IMPLEMENTADO (2026-09-16) — mas isto sozinho NUNCA origina
// uma chamada PSTN real. `TRUNK_EXTERNO_CONFIGURADO=true` só significa que
// ESTE arquivo sabe formar o dial-string do trunk contratado (usuário
// 148427001, servidor app.nvoip.com.br:5060, endpoint Asterisk
// [nvoip-endpoint] — ver config/asterisk/pjsip-nvoip.conf.example). O
// restante da cadeia de trava permanece INTOCADO e continua fail-closed:
//   1. O endpoint [nvoip-endpoint] só existe de verdade depois que um
//      humano aplicar pjsip-nvoip.conf no Asterisk real (WSL2) e confirmar
//      SIP registration — sem isso, um originate pra este endpoint falha
//      na hora (endpoint inexistente no Asterisk), não silenciosamente.
//   2. VOICE_EXTERNAL_ALLOWLIST (externalConfig.js) continua vazia por
//      padrão — nenhum número é permitido até um operador preencher.
//   3. automacoes_config.voice_external_enabled continua false no banco —
//      só SQL direto por um operador, sem rota PATCH, de propósito.
// Ou seja: este commit destrava só o "sabemos formar o endereço", nunca o
// "podemos discar" — os passos 1-16 de
// docs/cobranca-ai/NVOIP_HOMOLOGACAO.md continuam pendentes e continuam
// exigindo confirmação humana ouvindo áudio real antes de qualquer chamada
// de verdade.
export const TIPO_DESTINO = Object.freeze({ INTERNAL: 'INTERNAL', EXTERNAL: 'EXTERNAL' })

const ENDPOINT_INTERNO = 'PJSIP/7001'

// Nome do endpoint Asterisk definido em config/asterisk/pjsip-nvoip.conf.example
// ([nvoip-endpoint]). Número discado é anexado depois (ver
// outboundExternalTest.js: `${endpointBase}/${numero}`), formando o
// dial-string `PJSIP/nvoip-endpoint/<numero>` — mesma convenção do chan_pjsip
// pra endpoint de trunk com URI de destino sobrescrita.
const ENDPOINT_EXTERNO_NVOIP = 'PJSIP/nvoip-endpoint'

// Agora true: o adapter existe (ver comentário acima) — mas isto por si só
// nunca autoriza uma chamada real, ver as 3 travas independentes acima.
const TRUNK_EXTERNO_CONFIGURADO = true

export function resolverDestino(tipo) {
  if (tipo === TIPO_DESTINO.INTERNAL) return ENDPOINT_INTERNO
  if (tipo === TIPO_DESTINO.EXTERNAL) {
    if (!TRUNK_EXTERNO_CONFIGURADO) {
      throw new Error('EXTERNAL: nenhum trunk/adapter SIP configurado neste ambiente — fail-closed, chamada externa impossível neste MVP')
    }
    return ENDPOINT_EXTERNO_NVOIP
  }
  throw new Error(`tipo de destino desconhecido: "${tipo}"`)
}
