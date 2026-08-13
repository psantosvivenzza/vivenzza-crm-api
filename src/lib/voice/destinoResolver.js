// Voice AI EXTERNAL PILOT READINESS — abstração de destino. Objetivo:
// separar "pra onde a chamada vai" do resto do código, então quando um
// trunk real existir no futuro, ESTE é o único arquivo que precisa mudar
// (nenhum outro módulo deveria conhecer detalhe de endpoint).
//
// Hoje: INTERNAL resolve pro mesmo ramal PJSIP/7001 já homologado (PR #19).
// EXTERNAL não tem NENHUM adapter/trunk configurado — falha fechado, sempre,
// nesta rodada. Não existe número externo hardcoded em lugar nenhum deste
// arquivo nem do resto do código de voz.
export const TIPO_DESTINO = Object.freeze({ INTERNAL: 'INTERNAL', EXTERNAL: 'EXTERNAL' })

const ENDPOINT_INTERNO = 'PJSIP/7001'

// Único interruptor que precisaria virar `true` (e só depois de um adapter
// de trunk real existir) pra EXTERNAL deixar de ser fail-closed. Hoje é
// sempre false — não há trunk contratado, não há adapter implementado.
const TRUNK_EXTERNO_CONFIGURADO = false

export function resolverDestino(tipo) {
  if (tipo === TIPO_DESTINO.INTERNAL) return ENDPOINT_INTERNO
  if (tipo === TIPO_DESTINO.EXTERNAL) {
    if (!TRUNK_EXTERNO_CONFIGURADO) {
      throw new Error('EXTERNAL: nenhum trunk/adapter SIP configurado neste ambiente — fail-closed, chamada externa impossível neste MVP')
    }
    // Nunca alcançado nesta rodada (guard acima sempre lança primeiro) —
    // mantido explícito pra deixar claro que mesmo com trunk configurado,
    // ainda faltaria implementar o adapter real de fato.
    throw new Error('EXTERNAL: adapter de trunk ainda não implementado')
  }
  throw new Error(`tipo de destino desconhecido: "${tipo}"`)
}
